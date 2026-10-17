"""Unit tests for the pure parts of bridge.py (no SDK, no network beyond a local fake NOVA). Run: python3 -m unittest -v test_bridge"""
import contextlib
import io
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import bridge

ALLOW = {"harm@sip.linphone.org"}
SECRET = "GEHEIM-BERICHT-4711"


class Room:
    def __init__(self, level="encrypted", parts=("harm@sip.linphone.org",)):
        self.level, self.parts = level, list(parts)


class Msg:
    def __init__(self, peer="harm@sip.linphone.org", text=SECRET):
        self.peer, self.text = peer, text


def handlers(allow=ALLOW):
    state = bridge.State()
    state.allow = set(allow)
    dispatched, left = [], []
    h = bridge.Handlers(
        state,
        level_of=lambda r: r.level,
        peer_of=lambda m: m.peer,
        participants_of=lambda r: r.parts,
        text_of=lambda m: m.text,
        dispatch=lambda room, peer, text: dispatched.append((peer, text)),
        leave=left.append,
    )
    return h, state, dispatched, left


class Policy(unittest.TestCase):
    def test_only_allowed_one_to_one_encrypted_rooms_are_answered(self):
        v = bridge.verdict
        self.assertEqual(v("encrypted", "harm@sip.linphone.org", 1, ALLOW), "answer")
        self.assertEqual(v("safe", "harm@sip.linphone.org", 1, ALLOW), "answer")
        self.assertEqual(v("cleartext", "harm@sip.linphone.org", 1, ALLOW), "cleartext")
        self.assertEqual(v("unsafe", "harm@sip.linphone.org", 1, ALLOW), "unsafe_level")
        self.assertEqual(v("encrypted", "harm@sip.linphone.org", 2, ALLOW), "group")
        self.assertEqual(v("encrypted", "vreemde@sip.linphone.org", 1, ALLOW), "not_allowed")
        self.assertEqual(v("encrypted", "harm@sip.linphone.org", 1, set()), "not_allowed")  # empty list = nobody

    def test_cleartext_is_never_dispatched_even_from_an_allowed_contact(self):
        h, state, dispatched, left = handlers()
        h.on_message(Room("cleartext"), Msg())
        self.assertEqual(dispatched, [])
        self.assertEqual(state.cleartext_ignored, 1)
        self.assertEqual(left, [])

    def test_encrypted_allowed_is_dispatched_once(self):
        h, state, dispatched, _ = handlers()
        h.on_message(Room(), Msg())
        self.assertEqual(dispatched, [("harm@sip.linphone.org", SECRET)])

    def test_strangers_groups_unsafe_and_empty_texts_are_dropped(self):
        h, state, dispatched, _ = handlers()
        h.on_message(Room(), Msg(peer="vreemde@sip.linphone.org"))
        h.on_message(Room(parts=("a@x", "b@x")), Msg())
        h.on_message(Room("unsafe"), Msg())
        h.on_message(Room(), Msg(text=None))
        self.assertEqual(dispatched, [])
        self.assertEqual(state.rejected, 3)

    def test_rooms_of_strangers_and_groups_are_left_but_cleartext_rooms_are_not(self):
        h, state, _, left = handlers()
        stranger, group, ok, plain = Room(parts=("vreemde@sip.linphone.org",)), Room(parts=("a@x", "b@x")), Room(), Room("cleartext", ("x@y",))
        for r in (stranger, group, ok, plain):
            h.on_room_created(r)
        self.assertEqual(left, [stranger, group])

    def test_calls_are_only_counted(self):
        h, state, dispatched, left = handlers()
        for s in ("IncomingReceived", "IncomingEarlyMedia", "End", "Released"):
            h.on_call_state(s)
        self.assertEqual(state.calls_ignored, 2)
        # the call handler has no way to answer, decline or end a call: it receives only a state name
        self.assertEqual((dispatched, left), ([], []))

    def test_logs_never_contain_message_text(self):
        h, state, _, _ = handlers()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            h.on_message(Room("cleartext"), Msg())
            h.on_message(Room(), Msg())
            h.on_message(Room(), Msg(peer="vreemde@sip.linphone.org"))
            h.on_message(Room(parts=("a@x", "b@x")), Msg())
            h.on_unreadable()
            h.on_room_created(Room(parts=("vreemde@sip.linphone.org",)))
            h.on_call_state("IncomingReceived")
        self.assertTrue(out.getvalue())
        self.assertNotIn(SECRET, out.getvalue())
        self.assertNotIn("4711", out.getvalue())


class Identity(unittest.TestCase):
    def test_device_id_is_created_once_private_and_stable(self):
        with tempfile.TemporaryDirectory() as d:
            first = bridge.load_device_id(d)
            self.assertEqual(first, bridge.load_device_id(d))
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, "device-id")).st_mode), 0o600)
            os.remove(os.path.join(d, "device-id"))
            self.assertNotEqual(first, bridge.load_device_id(d))  # lost volume = new device

    def test_corrupt_device_id_is_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "device-id"), "w") as fh:
                fh.write("not-a-uuid")
            self.assertRegex(bridge.load_device_id(d), r"^[0-9a-f-]{36}$")

    def test_sip_user_and_secret_file(self):
        self.assertEqual(bridge.sip_user('"Harm" <sip:Harm@sip.linphone.org;gr=urn:uuid:1>'), "harm@sip.linphone.org")
        with tempfile.NamedTemporaryFile("w", delete=False) as fh:
            fh.write("pa ss\n")
        os.environ["TESTSECRET_FILE"] = fh.name
        try:
            self.assertEqual(bridge.read_secret("TESTSECRET"), "pa ss")
        finally:
            os.remove(fh.name)


class FakeNova(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        out = {"contacts": ["Harm@sip.linphone.org"], "identity": "sip:nova@sip.linphone.org"} if self.path.endswith("allowlist") else {"reply": "hoi"}
        out["seen_token"] = body.get("token")
        data = json.dumps(out).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


class NovaClient(unittest.TestCase):
    def test_allowlist_returns_lowercase_contacts_and_identity(self):
        srv = HTTPServer(("127.0.0.1", 0), FakeNova)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            nova = bridge.Nova(f"http://127.0.0.1:{srv.server_port}/api/integrations/linphone-chat", "tok")
            self.assertEqual(nova.allowlist(), (["harm@sip.linphone.org"], "sip:nova@sip.linphone.org"))
            self.assertEqual(nova.message("harm@sip.linphone.org", "x"), "hoi")
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
