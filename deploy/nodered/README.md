# NOVA Node-RED seed files

These files initialize an empty Node-RED `/data` directory. The entrypoint copies
each file only when its destination does not exist. Node-RED edits, credentials,
installed nodes, and all other persistent files remain in `nodered-data/` and are
never replaced during an upgrade.

The initial flow set contains the NOVA health heartbeat, built from Node-RED's
built-in nodes. The local `node-red-contrib-nova` module adds the NOVA chat,
TTS, alert and runtime-event nodes; the seed entrypoint installs it from the
read-only mount without using a public registry. See
[`docs/node-red-contrib-nova.md`](../../docs/node-red-contrib-nova.md) for its
contracts and limits and [`docs/node-red-health-heartbeat.md`](../../docs/node-red-health-heartbeat.md)
for the heartbeat.

Review and export future seed changes into `deploy/nodered/flows.json`; see
[`docs/node-red-flows.md`](../../docs/node-red-flows.md) for the live editor and
persistent-data boundary.

Production keeps the editor reachable only on the internal Compose network.
`settings.js` is deliberately minimal; do not put credentials or fixed secrets in
this repository. Configure authentication and other deployment-specific values
through secrets in the persistent runtime configuration when the editor is exposed.

When app access is enabled, Compose passes `NOVA_APP_TOKEN` privately to Node-RED.
Ordinary chat and speech nodes exchange it for an in-memory API session; the token
never enters flow JSON or outgoing node messages. After an API restart, only an
explicit pre-controller access rejection permits session renewal and one retry.
Network failures and other forbidden responses are not replayed automatically.
The event and proactive question nodes retain their narrower bearer-only route.
Recreate both NOVA and Node-RED when changing the app token. Local node package
version 0.1.2 provides this integration; update the seed sources before restarting.
