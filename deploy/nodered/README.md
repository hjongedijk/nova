# NOVA Node-RED seed files

These files initialize an empty Node-RED `/data` directory. The entrypoint copies
each file only when its destination does not exist. Node-RED edits, credentials,
installed nodes, and all other persistent files remain in `nodered-data/` and are
never replaced during an upgrade.

The initial flow set contains the NOVA health heartbeat, built from Node-RED's
built-in nodes. The local `node-red-contrib-nova` module adds the NOVA chat,
TTS, alert, runtime-event and durable briefing nodes; the seed entrypoint installs it from the
read-only mount without using a public registry. See
[Node-RED in `docs/integrations.md`](../../docs/integrations.md#the-nova-nodes) for its
contracts and limits and [the health heartbeat section](../../docs/integrations.md#health-heartbeat)
for the heartbeat.

Review and export future seed changes into `deploy/nodered/flows.json`; see
[`docs/integrations.md`](../../docs/integrations.md#seed-flows-and-persistent-data) for the live editor and
persistent-data boundary.

Production keeps the editor reachable only on the internal Compose network.
`settings.js` is deliberately minimal; do not put credentials or fixed secrets in
this repository. Configure authentication and other deployment-specific values
through secrets in the persistent runtime configuration when the editor is exposed.

Chat and speech nodes call the NOVA API directly; access is handled by the
reverse proxy in front of NOVA. The event and proactive question nodes retain their narrower bearer-only route.
Recreate both NOVA and Node-RED when changing the app token. Local node package
version 0.1.4 provides this integration; update the seed sources before restarting.
