# `node-red-contrib-nova`

NOVA ships four custom Node-RED nodes in
`deploy/nodered/node-red-contrib-nova`. The seed entrypoint installs this local
package into `/data` when its version is missing or changed. Sources come from
the read-only seed mount; no public registry or third-party node dependency is
needed. Node-RED keeps the installed version and operator dependencies in its
persistent `/data` directory.

| Node                 | Input                                                | Result                                                                                                                                |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **NOVA zeg**         | Text in `msg.payload` (up to 2,000 characters)       | NOVA MPEG audio buffer in `msg.payload`; connect to an audio output node. It does not control a speaker itself.                       |
| **NOVA vraag**       | Text in `msg.payload` (up to 10,000 characters)      | Reply in `msg.payload`; full sanitized chat result in `msg.nova`. Per-node chat session persists through NOVA's ordinary chat memory. |
| **NOVA melding**     | `{ title, detail?, severity? }` in `msg.payload`     | Bounded alert submitted to NOVA's authenticated event API.                                                                            |
| **NOVA gebeurtenis** | Error text or `{ detail, flowId? }` in `msg.payload` | Bounded runtime-error event submitted to NOVA's authenticated event API.                                                              |

Set `NOVA_API_URL` only when the default `http://nova:8080` is not reachable.
The node package accepts only the local NOVA service hostnames
(`nova`, `localhost`, `127.0.0.1`, or `host.docker.internal`) and fixed API paths;
message data cannot select a URL. Chat requests cannot pass confirmation IDs,
model/provider overrides or pre-approved tools. Any action remains subject to
NOVA's regular policy and confirmation gates.

The alert and runtime-event nodes read `NODE_RED_EVENT_TOKEN` from the
Node-RED process environment. They store no secret in flow JSON, cap requests
at the API's 4 KiB boundary and never put event content into the audit log.
Requests time out; API errors are bounded before they reach the flow's error
handler. TTS responses are capped at 2 MiB.

Run `npm test --prefix deploy/nodered/node-red-contrib-nova` for node behavior.
`node scripts/test-nodered-flows.mjs` starts an isolated Node-RED 4.1 container,
seeds the package, imports the flows and checks the Admin API for all four
registered node types. `node scripts/check-nodered-flows.mjs` scans flow JSON for
secret-like values.
