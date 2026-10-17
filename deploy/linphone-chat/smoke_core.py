"""Headless smoke test of the SDK (no real account): creates a Core without a sound card, prints version and feature flags,
tries to register against a closed local port and expects a Failed registration state. Run inside the image:
  docker run --rm --entrypoint /opt/venv/bin/python nova-linphone-chat:draft -I /app/smoke_core.py"""
import tempfile
import time

import linphone

d = tempfile.mkdtemp() + "/"
f = linphone.Factory.get()
f.set_data_dir(d)
f.set_config_dir(d)
f.set_cache_dir(d)
core = f.create_core_with_config(linphone.Config.new_with_factory(d + "rc", None), None)
core.lime_x3dh_enabled = True
print("version", linphone.Core.get_version())
print("lime_x3dh_available", core.lime_x3dh_available())
print("db_storage", f.is_database_storage_available)
print("flexisip_chat_backend", f.is_chatroom_backend_available(linphone.ChatRoomBackend.ChatRoomBackendFlexisipChat))
states: list[str] = []
cbs = f.create_core_listener()
cbs.on_account_registration_state_changed = lambda c, a, s, m: states.append(str(s))
core.add_listener(cbs)
p = core.create_account_params()
a = f.create_address("sip:smoke@127.0.0.1")
p.identity_address = a
p.server_address = f.create_address("sip:127.0.0.1:1;transport=tcp")
p.register_enabled = True
acc = core.create_account(p)
core.add_auth_info(f.create_auth_info("smoke", None, "x", None, None, "127.0.0.1"))
core.add_account(acc)
core.start()
t = time.time()
while time.time() - t < 8:
    core.iterate()
    time.sleep(0.02)
print("registration_states", states, "(Failed expected: nothing listens)")
core.stop()
