"""Headless smoke test of the bridge's Core configuration with the REAL SDK. No real account, nothing leaves the container:
a fake UDP registrar on 127.0.0.1 plays "Flexisip", and the test sends the Core hand-made SIP requests.

Checks (exit code 1 on any failure):
  1. SDK features: LIME, DB storage, Flexisip chat backend.
  2. Registration: User-Agent is NOVA-chat-bridge, Contact carries +sip.instance = the persisted device id, and the id is
     the same after a restart with the same data directory (LIME needs a stable device).
  3. Calls: an incoming INVITE is never answered/ringing/declined with 603 (we expect the SDK's own 488) and nothing else.
  4. Cleartext MESSAGE: counted as ignored, never dispatched to NOVA (no double reply next to Asterisk).
  5. No message text in the output (verify with: ... | grep -c SECRET-CLEARTEXT, expect 0).

Run inside the image (dead registrar and dead LIME URL, the defaults below):
  docker run --rm --entrypoint /opt/venv/bin/python nova-linphone-chat:local -I /app/smoke_core.py"""
import os
import re
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import linphone  # noqa: E402

import bridge  # noqa: E402

DEAD_LIME = "http://127.0.0.1:9/lime"  # nothing listens: never talk to the real LIME server from a test
SECRET_TEXT = "SECRET-CLEARTEXT-BODY-4711"
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("PASS " if ok else "FAIL ") + name, detail if detail != "" else "")
    if not ok:
        failures.append(name)


class FakeRegistrar:
    """Answers REGISTER with 200 OK and remembers the requests."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.registers: list[str] = []
        self.stop = False
        threading.Thread(target=self.run, daemon=True).start()

    def run(self) -> None:
        while not self.stop:
            try:
                data, addr = self.sock.recvfrom(65535)
            except OSError:
                continue
            text = data.decode(errors="replace")
            if not text.startswith("REGISTER"):
                continue
            self.registers.append(text)
            keep = [ln + ";expires=3600" if ln.startswith("Contact:") else ln for ln in text.split("\r\n") if re.match(r"(Via|From|Call-ID|CSeq|Contact):", ln, re.I)]
            to = next(ln for ln in text.split("\r\n") if ln.lower().startswith("to:"))
            if "<" not in to:  # `To: sip:x` has no brackets, so a tag must not be appended as a URI parameter
                to = "To: <" + to.split(":", 1)[1].strip() + ">"
            reply = "SIP/2.0 200 OK\r\n" + "\r\n".join(keep) + f"\r\n{to};tag=reg1\r\nExpires: 3600\r\nContent-Length: 0\r\n\r\n"
            self.sock.sendto(reply.encode(), addr)


def run_core(data: str, registrar: FakeRegistrar, listen_port: int, seconds: float, probe=None):
    factory, core = bridge.make_core(linphone, data, lime_url=DEAD_LIME, transports=(listen_port, 0))
    state = bridge.State()
    dispatched: list[tuple[str, str]] = []
    handlers = bridge.attach_listeners(linphone, factory, core, state, lambda _room, peer, text: dispatched.append((peer, text)))
    params = core.create_account_params()
    addr = factory.create_address("sip:nova@127.0.0.1")
    params.identity_address = addr
    params.server_address = factory.create_address(f"sip:127.0.0.1:{registrar.port};transport=udp")
    params.register_enabled = True
    params.expires = 3600
    params.push_notification_allowed = False
    params.instant_messaging_encryption_mandatory = False
    core.add_auth_info(factory.create_auth_info("nova", None, "unused", None, None, "127.0.0.1"))
    account = core.create_account(params)
    core.add_account(account)
    core.default_account = account
    core.start()
    start = time.time()
    probed = False
    out = None
    while time.time() - start < seconds:
        core.iterate()
        if probe and not probed and state.reg_state == "Ok":
            probed = True
            out = probe(core, state)
            state.registered_during_run = True
        time.sleep(0.02)
    del handlers
    core.stop()
    for _ in range(25):  # let the unregister go out
        core.iterate()
        time.sleep(0.02)
    return state, dispatched, out, factory, core


def udp_exchange(port: int, payload: str, wait: float = 3.0) -> list[str]:
    """Send one request to the Core and collect the start lines of everything it answers (keeps iterating via the caller)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 5999))  # the Via of sip() names this port
    s.settimeout(0.05)
    s.sendto(payload.encode(), ("127.0.0.1", port))
    return [s, wait]  # type: ignore[return-value]


def collect(core, sock_wait) -> list[str]:
    sock, wait = sock_wait
    got: list[str] = []
    end = time.time() + wait
    while time.time() < end:
        core.iterate()
        try:
            data, _ = sock.recvfrom(65535)
            got.append(data.decode(errors="replace").split("\r\n")[0])
        except OSError:
            pass
    sock.close()
    return got


def sip(method: str, port: int, body: str, content_type: str | None, call_id: str) -> str:
    head = [
        f"{method} sip:nova@127.0.0.1:{port} SIP/2.0",
        "Via: SIP/2.0/UDP 127.0.0.1:5999;branch=z9hG4bK" + call_id,
        "Max-Forwards: 70",
        "From: <sip:caller@127.0.0.1>;tag=abc",
        "To: <sip:nova@127.0.0.1>",
        f"Call-ID: {call_id}",
        f"CSeq: 1 {method}",
        "Contact: <sip:caller@127.0.0.1:5999>",
    ]
    if content_type:
        head.append(f"Content-Type: {content_type}")
    head.append(f"Content-Length: {len(body.encode())}")
    return "\r\n".join(head) + "\r\n\r\n" + body


SDP = (
    "v=0\r\no=caller 1 1 IN IP4 127.0.0.1\r\ns=call\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"
    "m=audio 7078 RTP/AVP 0 8\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n"
)

d = tempfile.mkdtemp()
f = linphone.Factory.get()
for setter in (f.set_data_dir, f.set_config_dir, f.set_cache_dir):
    setter(d + "/")
print("version", linphone.Core.get_version())
probe_core = f.create_core_with_config(linphone.Config.new_with_factory(d + "/probe", None), None)
probe_core.lime_x3dh_enabled = True
check("lime_x3dh_available", bool(probe_core.lime_x3dh_available()))
check("db_storage", bool(f.is_database_storage_available))
check("flexisip_chat_backend", bool(f.is_chatroom_backend_available(linphone.ChatRoomBackend.ChatRoomBackendFlexisipChat)))

registrar = FakeRegistrar()
data = tempfile.mkdtemp()
PORT = 15070
replies: dict[str, list[str]] = {}


def probe(core, state):
    # (3) call and (4) cleartext message arrive while registered
    inv = udp_exchange(PORT, sip("INVITE", PORT, SDP, "application/sdp", "call-1"))
    replies["invite"] = collect(core, inv)
    msg = udp_exchange(PORT, sip("MESSAGE", PORT, SECRET_TEXT, "text/plain", "msg-1"))
    replies["message"] = collect(core, msg)


state1, dispatched1, _, _, _ = run_core(data, registrar, PORT, 25, probe)
first = registrar.registers[0] if registrar.registers else ""
device_id = open(os.path.join(data, "device-id"), encoding="utf-8").read().strip()
check("registered", getattr(state1, "registered_during_run", False))
check("user_agent", bool(re.search(r"^User-Agent: NOVA-chat-bridge", first, re.M | re.I)))
check("sip_instance_is_device_id", f"urn:uuid:{device_id}" in first, device_id[:8])
check("uuid_is_mode_0600", (os.stat(os.path.join(data, "device-id")).st_mode & 0o777) == 0o600)
check("unregister_is_own_contact_not_star", not any(re.search(r"^Contact: \*", r, re.M) for r in registrar.registers))

codes = [r.split(" ", 2)[1] if r.startswith("SIP/2.0") else r for r in replies.get("invite", [])]
print("invite_responses", replies.get("invite"))
check("call_never_answered_or_declined", bool(codes) and not any(c in ("180", "183", "200", "603", "486", "480") for c in codes), codes)
check("call_refused_by_sdk_with_488", "488" in codes, codes)
print("message_responses", replies.get("message"))
check("cleartext_counted_ignored", state1.cleartext_ignored == 1, state1.cleartext_ignored)
check("cleartext_never_dispatched", dispatched1 == [], dispatched1)

registrar.registers.clear()
run_core(data, registrar, PORT, 6, None)
second = registrar.registers[0] if registrar.registers else ""
check("device_id_stable_after_restart", f"urn:uuid:{device_id}" in second)
check("same_user_agent_after_restart", "NOVA-chat-bridge" in second)

registrar.stop = True
sys.exit(1 if failures else 0)
