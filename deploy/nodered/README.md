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
