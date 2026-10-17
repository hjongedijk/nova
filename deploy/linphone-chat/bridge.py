"""NOVA <-> Linphone end-to-end encrypted chat bridge (UNTESTED DRAFT, see docs/linphone-encrypted-chat.md).

Logs in as its OWN Linphone account, accepts encrypted (LIME) 1:1 chat rooms from allow-listed contacts, forwards each
decrypted text to NOVA (POST {NOVA_URL}/message) and sends NOVA's reply back into the same encrypted room.
Message bodies are never logged. Needs the Belledonne `linphone` wheel (liblinphone 5.5, Python 3.12).

Threading: liblinphone is single-threaded, so only the main thread touches the Core. HTTP calls to NOVA run in worker
threads and hand their reply back through a queue that the main loop drains.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Everything below the import line of `linphone` is pure Python so it can be unit-tested without the SDK.


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None or v == "":
        raise SystemExit(f"missing environment variable {name}")
    return v


def read_secret(name: str) -> str:
    """Secrets come from a file (`NAME_FILE`, e.g. a Docker secret) or, as a fallback, from the environment. Never logged."""
    path = os.environ.get(f"{name}_FILE")
    if path:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    return env(name)


def sip_user(address: str) -> str:
    """`sip:harm@sip.linphone.org;gr=x` or `"Harm" <sip:...>` -> `harm@sip.linphone.org` (lower case)."""
    import re

    m = re.search(r"sips?:([^@;>\s\"]+)@([^;>\s:\"]+)", address, re.I)
    return f"{m.group(1)}@{m.group(2)}".lower() if m else ""


def log(msg: str, **fields: object) -> None:
    """Metadata only. Never pass message text here."""
    extra = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} nova-chat {msg} {extra}".rstrip(), flush=True)


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

    def allowlist(self) -> list[str]:
        return [a.lower() for a in self._post("allowlist", {}, 10).get("contacts", [])]

    def message(self, sender: str, text: str) -> str:
        return str(self._post("message", {"from": f"sip:{sender}", "text": text}, 60).get("reply", ""))


class State:
    def __init__(self) -> None:
        self.started = time.time()
        self.registered_at: float | None = None
        self.last_ok: float = time.time()
        self.reg_state = "None"
        self.lime = False
        self.answered = 0
        self.rejected = 0
        self.unreadable = 0
        self.failed = 0
        self.allow: set[str] = set()
        self.lock = threading.Lock()

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
            "uptimeSeconds": int(time.time() - self.started),
        }


def serve_health(state: State, port: int) -> None:
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


def main() -> None:  # pragma: no cover - needs the SDK and a real account
    import linphone  # imported late so the helpers above are testable without the wheel

    data = os.environ.get("NOVA_CHAT_DATA", "/data")
    identity = env("LINPHONE_IDENTITY")  # sip:nova-chat@sip.linphone.org
    server = env("LINPHONE_SERVER", "sip:sip.linphone.org;transport=tls")
    lime_url = env("LINPHONE_LIME_URL", "https://lime.linphone.org/lime-server/lime-server.php")
    factory_uri = env("LINPHONE_CONFERENCE_FACTORY", "sip:conference-factory@sip.linphone.org")
    password = read_secret("LINPHONE_PASSWORD")
    nova = Nova(env("NOVA_URL", "http://nova:3000/api/integrations/linphone-chat"), read_secret("NOVA_CHAT_TOKEN"))
    static_allow = {a.strip().lower() for a in os.environ.get("NOVA_CHAT_ALLOW", "").split(",") if a.strip()}
    allow_cleartext = os.environ.get("NOVA_CHAT_ALLOW_CLEARTEXT", "0") == "1"
    state = State()
    serve_health(state, int(os.environ.get("NOVA_CHAT_HEALTH_PORT", "8099")))

    factory = linphone.Factory.get()
    for setter in (factory.set_data_dir, factory.set_config_dir, factory.set_cache_dir):
        setter(data + "/")
    cfg = linphone.Config.new_with_factory(os.path.join(data, "linphonerc"), None)
    core = factory.create_core_with_config(cfg, None)
    core.video_capture_enabled = core.video_display_enabled = False
    core.keep_alive_enabled = True
    core.set_user_agent("NOVA-chat-bridge", "0")
    core.lime_x3dh_server_url = lime_url
    core.lime_x3dh_enabled = True
    state.lime = bool(core.lime_x3dh_available())
    if not (factory.is_database_storage_available and state.lime):
        raise SystemExit("this liblinphone build lacks DB storage or LIME; cannot do encrypted chat")

    params = core.create_account_params()
    addr = factory.create_address(identity)
    params.identity_address = addr
    params.server_address = factory.create_address(server)
    params.register_enabled = True
    params.push_notification_allowed = False
    params.conference_factory_uri = factory_uri
    params.lime_server_url = lime_url
    params.lime_algo = "c25519"
    params.instant_messaging_encryption_mandatory = not allow_cleartext
    account = core.create_account(params)
    core.add_auth_info(factory.create_auth_info(addr.username, None, password, None, None, addr.domain))
    core.add_account(account)
    core.default_account = account

    replies: "queue.Queue[tuple[object, str]]" = queue.Queue()

    def refresh_allow() -> None:
        try:
            state.allow = set(nova.allowlist()) | static_allow
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

    def room_ok(room: object, peer: str) -> bool:
        encrypted = room.security_level in (  # type: ignore[attr-defined]
            linphone.ChatRoomSecurityLevel.ChatRoomSecurityLevelEncrypted,
            linphone.ChatRoomSecurityLevel.ChatRoomSecurityLevelSafe,
        )
        return peer in state.allow and (encrypted or allow_cleartext) and room.nb_participants == 1  # type: ignore[attr-defined]

    def on_message(_core: object, room: object, msg: object) -> None:
        peer = sip_user(msg.from_address.as_string_uri_only())  # type: ignore[attr-defined]
        if not msg.is_text or not room_ok(room, peer):  # type: ignore[attr-defined]
            state.rejected += 1
            log("message ignored", reason="not_text_or_not_allowed")
            return
        text = msg.utf8_text  # type: ignore[attr-defined]
        if text:
            threading.Thread(target=work, args=(room, peer, text), daemon=True).start()

    def on_unreadable(*_: object) -> None:
        state.unreadable += 1
        log("undecryptable message")

    def on_room_state(_core: object, room: object, st: int) -> None:
        # Incoming Flexisip conference chat rooms are joined automatically by liblinphone; leave rooms from strangers and groups.
        if st != linphone.ChatRoomState.ChatRoomStateCreated:
            return
        parts = [sip_user(p.address.as_string_uri_only()) for p in room.participants]  # type: ignore[attr-defined]
        if len(parts) != 1 or parts[0] not in state.allow:
            state.rejected += 1
            log("chat room refused", participants=len(parts))
            core.delete_chat_room(room)

    def on_reg(_core: object, acc: object, st: int, _msg: str) -> None:
        names = {v: k for k, v in vars(linphone.RegistrationState).items() if k.startswith("RegistrationState")}
        state.reg_state = names.get(st, str(st)).removeprefix("RegistrationState")
        if state.reg_state == "Ok":
            state.last_ok = time.time()
        log("registration", state=state.reg_state)

    cbs = factory.create_core_listener()
    cbs.on_message_received = on_message
    cbs.on_message_received_unable_decrypt = on_unreadable
    cbs.on_chat_room_state_changed = on_room_state
    cbs.on_account_registration_state_changed = on_reg
    core.add_listener(cbs)

    core.start()
    log("started", version=linphone.Core.get_version() if hasattr(linphone.Core, "get_version") else "?", lime=state.lime)
    running = True

    def stop(*_: object) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    refresh_allow()
    next_allow = time.time() + 60
    while running:
        core.iterate()
        try:
            while True:
                room, text = replies.get_nowait()
                m = room.create_message_from_utf8(text)  # type: ignore[attr-defined]
                m.send()
                state.answered += 1
        except queue.Empty:
            pass
        now = time.time()
        if now >= next_allow:
            next_allow = now + 60
            threading.Thread(target=refresh_allow, daemon=True).start()
        gap = now - state.last_ok
        if state.reg_state != "Ok" and gap > 120 and int(gap) % 60 == 0:
            core.refresh_registers()
        if gap > 900:  # restart policy of the container takes over
            log("registration lost for 15 minutes, exiting")
            sys.exit(1)
        time.sleep(0.02)
    core.stop()


if __name__ == "__main__":  # pragma: no cover
    main()
