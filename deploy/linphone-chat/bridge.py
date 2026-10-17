"""NOVA <-> Linphone end-to-end encrypted chat bridge (UNTESTED against a real account, see docs/linphone-encrypted-chat.md).

Design: the bridge logs in with the SAME Linphone account that Asterisk registers with (the NOVA trunk). Flexisip forks to
every registration of an account, so this process must be a polite second device:

  * CALLS: never answered, declined, terminated or otherwise touched. All audio/video/text payloads are disabled so the
    SDK itself refuses an incoming INVITE with a non-global 488 before any ringing (a 603 Decline would end the forked
    call for Asterisk too). The call listener only counts.
  * CLEARTEXT messages (also forked to Asterisk, which already answers them via the SIP relay): ignored, never answered,
    so there are no double replies. The bridge answers ONLY end-to-end encrypted (LIME) one-to-one rooms.
  * Allow-list: only contacts NOVA marks "may talk to NOVA". Strangers' and group rooms are left.
  * Device identity: a stable UUID in the data volume (misc/uuid -> +sip.instance, which Flexisip turns into the GRUU that
    LIME keys belong to) and a recognisable User-Agent, so Flexisip treats it as its own device next to Asterisk.

Message bodies are never logged. The SIP password comes from a file. Needs the Belledonne `linphone` wheel (liblinphone
5.5, Python 3.12). liblinphone is single-threaded: only the main thread touches the Core; HTTP calls to NOVA run in worker
threads and hand their reply back through a queue.
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

USER_AGENT = "NOVA-chat-bridge"
BRIDGE_VERSION = "0.2"

# Everything above `main()` is pure Python so it can be unit-tested without the SDK (see test_bridge.py).


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None or v == "":
        raise SystemExit(f"missing environment variable {name}")
    return v


def read_secret(name: str) -> str:
    """Secrets come from a file (`NAME_FILE`, a mounted secret) or, as a fallback, from the environment. Never logged."""
    path = os.environ.get(f"{name}_FILE")
    if path:
        with open(path, encoding="utf-8") as fh:
            return fh.read().rstrip("\r\n")
    return env(name)


def sip_user(address: str) -> str:
    """`sip:harm@sip.linphone.org;gr=x` or `"Harm" <sip:...>` -> `harm@sip.linphone.org` (lower case)."""
    m = re.search(r"sips?:([^@;>\s\"]+)@([^;>\s:\"]+)", address, re.I)
    return f"{m.group(1)}@{m.group(2)}".lower() if m else ""


def log(msg: str, **fields: object) -> None:
    """Metadata only. Never pass message text here."""
    extra = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} nova-chat {msg} {extra}".rstrip(), flush=True)


def load_device_id(data_dir: str) -> str:
    """Stable per-device identity: created once, kept in the data volume. A new id = a new LIME device and a new GRUU."""
    path = os.path.join(data_dir, "device-id")
    try:
        with open(path, encoding="utf-8") as fh:
            value = fh.read().strip()
        return str(uuid.UUID(value))
    except (OSError, ValueError):
        value = str(uuid.uuid4())
        tmp = f"{path}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(value + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return value


class Nova:
    """The NOVA-facing half: see apps/api/src/telephony/messaging.controller.ts (`integrations/linphone-chat`)."""

    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def _post(self, path: str, payload: dict, timeout: float) -> dict:
        data = json.dumps({"token": self.token, **payload}).encode()
        req = urllib.request.Request(
            f"{self.base}/{path}", data=data, headers={"content-type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (fixed internal URL)
            return json.loads(res.read().decode() or "{}")

    def allowlist(self) -> tuple[list[str], str | None]:
        """(allowed contacts, SIP identity of NOVA's trunk account as `sip:user@host`, or None while no trunk exists)."""
        out = self._post("allowlist", {}, 10)
        identity = out.get("identity")
        return [str(a).lower() for a in out.get("contacts", [])], identity if isinstance(identity, str) else None

    def message(self, sender: str, text: str) -> str:
        return str(self._post("message", {"from": f"sip:{sender}", "text": text}, 60).get("reply", ""))


class State:
    def __init__(self) -> None:
        self.started = time.time()
        self.last_ok: float = time.time()
        self.reg_state = "None"
        self.lime = False
        self.answered = 0
        self.rejected = 0
        self.unreadable = 0
        self.failed = 0
        self.calls_ignored = 0
        self.cleartext_ignored = 0
        self.allow: set[str] = set()

    def healthy(self, grace: float = 300.0) -> bool:
        return self.reg_state == "Ok" or (time.time() - self.last_ok) < grace

    def snapshot(self) -> dict:
        return {
            "ok": self.healthy(),
            "registration": self.reg_state,
            "lime": self.lime,
            "allowed": len(self.allow),
            "answered": self.answered,
            "rejected": self.rejected,
            "unreadable": self.unreadable,
            "failed": self.failed,
            "callsIgnored": self.calls_ignored,
            "cleartextIgnored": self.cleartext_ignored,
            "uptimeSeconds": int(time.time() - self.started),
        }


# --- Policy (pure) -------------------------------------------------------------------------------------------------

ENCRYPTED = {"encrypted", "safe"}


def verdict(level: str, peer: str, participants: int, allow: set[str]) -> str:
    """`answer` or the reason to ignore. `level` is the room's security level as a lower-case name.

    The dedupe rule: cleartext is the Asterisk path's job (Flexisip forks it to both registrations), encrypted rooms are the
    bridge's job (they are addressed to the bridge's own GRUU). So a message is answered by exactly one of the two."""
    if level not in ENCRYPTED:
        return "cleartext" if level == "cleartext" else "unsafe_level"
    if participants != 1:
        return "group"
    if peer not in allow:
        return "not_allowed"
    return "answer"


class Handlers:
    """Listener logic with the SDK behind small adapters, so tests can drive it with fakes."""

    def __init__(
        self,
        state: State,
        level_of: Callable[[object], str],
        peer_of: Callable[[object], str],
        participants_of: Callable[[object], list[str]],
        text_of: Callable[[object], str | None],
        dispatch: Callable[[object, str, str], None],
        leave: Callable[[object], None],
    ) -> None:
        self.state = state
        self.level_of, self.peer_of, self.participants_of = level_of, peer_of, participants_of
        self.text_of, self.dispatch, self.leave = text_of, dispatch, leave

    def on_message(self, room: object, msg: object) -> None:
        peer = self.peer_of(msg)
        why = verdict(self.level_of(room), peer, len(self.participants_of(room)), self.state.allow)
        if why == "cleartext":
            # Asterisk answers cleartext; answering here too would double every reply.
            self.state.cleartext_ignored += 1
            log("message ignored", reason="cleartext")
            return
        if why != "answer":
            self.state.rejected += 1
            log("message ignored", reason=why)
            return
        text = self.text_of(msg)
        if text:
            self.dispatch(room, peer, text)

    def on_unreadable(self) -> None:
        self.state.unreadable += 1
        log("undecryptable message")

    def on_room_created(self, room: object) -> None:
        parts = self.participants_of(room)
        # A cleartext room is never left or deleted: that is a normal chat the Asterisk path serves.
        if self.level_of(room) == "cleartext":
            return
        if len(parts) != 1 or parts[0] not in self.state.allow:
            self.state.rejected += 1
            log("chat room refused", participants=len(parts))
            self.leave(room)

    def on_call_state(self, state_name: str) -> None:
        """Calls are Asterisk's. Count only; never accept, decline or terminate (a 603 would kill the forked call)."""
        if state_name in ("IncomingReceived", "IncomingEarlyMedia"):
            self.state.calls_ignored += 1
            log("incoming call ignored (left to the other registration)")


def serve_health(state: State, port: int) -> ThreadingHTTPServer:
    class H(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            snap = state.snapshot()
            body = json.dumps(snap).encode()
            self.send_response(200 if snap["ok"] and self.path.startswith("/health") else 503)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            pass

    srv = ThreadingHTTPServer(("0.0.0.0", port), H)  # noqa: S104 (container-internal, not published)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def make_core(linphone, data: str, *, user_agent: str = USER_AGENT, lime_url: str, transports: tuple[int, int] | None = None):
    """A Core that can chat but never takes calls. Shared by the bridge and the smoke test."""
    factory = linphone.Factory.get()
    for setter in (factory.set_data_dir, factory.set_config_dir, factory.set_cache_dir):
        setter(data.rstrip("/") + "/")
    cfg = linphone.Config.new_with_factory(os.path.join(data, "linphonerc"), None)
    cfg.set_string("misc", "uuid", load_device_id(data))  # stable +sip.instance, survives container recreation
    core = factory.create_core_with_config(cfg, None)
    # Warning by default. 'message' adds chat room and LIME events (no SIP bodies); never use debug/trace in production.
    level = {"warning": linphone.LogLevel.LogLevelWarning, "message": linphone.LogLevel.LogLevelMessage}.get(
        os.environ.get("NOVA_CHAT_LOG_LEVEL", "warning").lower(), linphone.LogLevel.LogLevelWarning
    )
    linphone.LoggingService.get().set_log_level(level)
    # Calls: no codec at all => the SDK refuses an INVITE itself (488 Not Acceptable Here), no ringing, no answer.
    for pts in (core.audio_payload_types, core.video_payload_types, core.text_payload_types):
        for pt in pts:
            pt.enable(False)
    core.video_capture_enabled = core.video_display_enabled = False
    core.auto_send_ringing_enabled = False
    core.inc_timeout = 60
    core.keep_alive_enabled = True
    # The compose network has no IPv6 route: trying AAAA first made the LIME server and TLS connects fail with 'Network is unreachable'.
    core.ipv6_enabled = False
    core.set_user_agent(user_agent, BRIDGE_VERSION)
    core.lime_x3dh_server_url = lime_url
    core.lime_x3dh_enabled = True
    # No read/delivery receipts and typing indicators towards the sender: nothing leaves this device but real replies.
    policy = core.im_notif_policy
    policy.clear()
    if transports:
        t = core.transports
        t.udp_port, t.tcp_port, t.tls_port = transports[0], transports[1], -1
        core.transports = t
    return factory, core


def attach_listeners(linphone, factory, core, state: State, dispatch: Callable[[object, str, str], None]) -> Handlers:
    """Wire the SDK callbacks to `Handlers`. Shared by the bridge and the smoke test. Calls are observed, never answered."""
    level = linphone.ChatRoomSecurityLevel
    level_names = {
        level.ChatRoomSecurityLevelClearText: "cleartext",
        level.ChatRoomSecurityLevelEncrypted: "encrypted",
        level.ChatRoomSecurityLevelSafe: "safe",
        level.ChatRoomSecurityLevelUnsafe: "unsafe",
    }
    call_names = {v: k.removeprefix("CallState") for k, v in vars(linphone.CallState).items() if k.startswith("CallState")}
    reg_names = {
        v: k.removeprefix("RegistrationState") for k, v in vars(linphone.RegistrationState).items() if k.startswith("RegistrationState")
    }
    h = Handlers(
        state,
        level_of=lambda room: level_names.get(room.security_level, "unsafe"),
        peer_of=lambda msg: sip_user(msg.from_address.as_string_uri_only()),
        participants_of=lambda room: [sip_user(p.address.as_string_uri_only()) for p in room.participants],
        text_of=lambda msg: msg.utf8_text if msg.is_text else None,
        dispatch=dispatch,
        leave=core.delete_chat_room,
    )

    def on_room_state(_core: object, room: object, st: int) -> None:
        if st == linphone.ChatRoomState.ChatRoomStateCreated:
            h.on_room_created(room)

    def on_reg(_core: object, _acc: object, st: int, _msg: str) -> None:
        state.reg_state = reg_names.get(st, str(st))
        if state.reg_state == "Ok":
            state.last_ok = time.time()
        log("registration", state=state.reg_state)

    cbs = factory.create_core_listener()
    cbs.on_message_received = lambda _c, room, msg: h.on_message(room, msg)
    cbs.on_message_received_unable_decrypt = lambda *_: h.on_unreadable()
    cbs.on_chat_room_state_changed = on_room_state
    cbs.on_account_registration_state_changed = on_reg
    cbs.on_call_state_changed = lambda _c, _call, st, _m: h.on_call_state(call_names.get(st, str(st)))  # observe only
    core.add_listener(cbs)
    h.listener = cbs  # the Python wrapper does not keep it alive: callers must keep `h` referenced too
    return h


def main() -> None:  # pragma: no cover - needs the SDK and a real account
    import linphone  # imported late so the helpers above are testable without the wheel

    data = os.environ.get("NOVA_CHAT_DATA", "/data")
    lime_url = env("LINPHONE_LIME_URL", "https://lime.linphone.org/lime-server/lime-server.php")
    factory_uri = env("LINPHONE_CONFERENCE_FACTORY", "sip:conference-factory@sip.linphone.org")
    password = read_secret("LINPHONE_PASSWORD")
    nova = Nova(env("NOVA_URL", "http://nova:8080/api/integrations/linphone-chat"), read_secret("NOVA_CHAT_TOKEN"))
    static_allow = {a.strip().lower() for a in os.environ.get("NOVA_CHAT_ALLOW", "").split(",") if a.strip()}
    state = State()
    serve_health(state, int(os.environ.get("NOVA_CHAT_HEALTH_PORT", "8099")))

    # Identity of the shared account: env override, else NOVA's trunk (username@host) via the token-protected endpoint.
    identity = os.environ.get("LINPHONE_IDENTITY", "")
    deadline = time.time() + 300
    while True:
        try:
            contacts, from_nova = nova.allowlist()
            state.allow = set(contacts) | static_allow
            identity = identity or from_nova or ""
        except Exception as exc:
            log("NOVA not reachable yet", error=type(exc).__name__)
        if identity:
            break
        if time.time() > deadline:
            log("no SIP identity (set up the trunk in NOVA or set LINPHONE_IDENTITY), exiting")
            sys.exit(1)
        time.sleep(10)
    domain = sip_user(identity).split("@")[-1]
    server = env("LINPHONE_SERVER", f"sip:{domain};transport=tls")

    factory, core = make_core(linphone, data, lime_url=lime_url)
    state.lime = bool(core.lime_x3dh_available())
    if not (factory.is_database_storage_available and state.lime):
        raise SystemExit("this liblinphone build lacks DB storage or LIME; cannot do encrypted chat")

    params = core.create_account_params()
    addr = factory.create_address(identity)
    params.identity_address = addr
    params.server_address = factory.create_address(server)
    params.register_enabled = True
    params.expires = 3600  # same order as Asterisk's expiration=3600; liblinphone refreshes at ~half
    params.push_notification_allowed = False
    params.conference_factory_uri = factory_uri
    params.lime_server_url = lime_url
    params.lime_algo = "c25519"
    # Not "mandatory": that would make the SDK reject cleartext MESSAGEs itself (status code unknown). We ignore them instead.
    params.instant_messaging_encryption_mandatory = False
    account = core.create_account(params)
    core.add_auth_info(factory.create_auth_info(addr.username, None, password, None, None, addr.domain))
    core.add_account(account)
    core.default_account = account

    replies: "queue.Queue[tuple[object, str]]" = queue.Queue()

    def refresh_allow() -> None:
        try:
            contacts, _ = nova.allowlist()
            state.allow = set(contacts) | static_allow
        except Exception as exc:  # keep the last known list; fail closed when empty
            log("allowlist refresh failed", error=type(exc).__name__)

    def work(room: object, sender: str, text: str) -> None:
        try:
            reply = nova.message(sender, text)
        except Exception as exc:
            state.failed += 1
            log("nova request failed", error=type(exc).__name__)
            return
        if reply:
            replies.put((room, reply))

    def dispatch(room: object, sender: str, text: str) -> None:
        threading.Thread(target=work, args=(room, sender, text), daemon=True).start()

    handlers = attach_listeners(linphone, factory, core, state, dispatch)  # keep the reference (callbacks die with it)

    core.start()
    log("started", version=linphone.Core.get_version(), lime=state.lime, device=load_device_id(data)[:8])
    running = True

    def stop(*_: object) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_allow = time.time() + 60
    next_refresh = 0.0
    while running:
        core.iterate()
        try:
            while True:
                room, text = replies.get_nowait()
                room.create_message_from_utf8(text).send()  # type: ignore[attr-defined]
                state.answered += 1
        except queue.Empty:
            pass
        now = time.time()
        if now >= next_allow:
            next_allow = now + 60
            threading.Thread(target=refresh_allow, daemon=True).start()
        gap = now - state.last_ok
        if state.reg_state != "Ok" and gap > 120 and now >= next_refresh:
            next_refresh = now + 60
            core.refresh_registers()
        if gap > 900:  # restart policy of the container takes over
            log("registration lost for 15 minutes, exiting")
            sys.exit(1)
        time.sleep(0.02)
    del handlers
    core.stop()  # unregisters only this device's own contact (not `*`): Asterisk's registration stays


if __name__ == "__main__":  # pragma: no cover
    main()
