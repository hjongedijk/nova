# Node-RED flows in NOVA

The reviewed seed file is `deploy/nodered/flows.json`. To publish a flow change,
export the selected flow(s) from the Node-RED editor as formatted JSON and update
that file; keep unrelated credentials out of the export. `scripts/test-nodered-flows.mjs`
imports the seed into an isolated Node-RED 4.1 container, while
`scripts/check-nodered-flows.mjs` rejects credential-like values and embedded
tokens.

The deployment seed script copies the seed only into an empty persistent
`/data` directory. It never replaces an existing `/data/flows.json`, so an
upgrade cannot silently overwrite operator flows. Import reviewed updates into
the live editor deliberately, or back up its persistent data before replacing
flows. NOVA's Settings page exposes only tab names and counts; it never exports
the live executable flow configuration.

The editor is not published by the production Compose stack. If you expose it
through an authenticated reverse proxy or another trusted access path, set
`NODE_RED_EDITOR_URL` to the browser-reachable URL. Settings shows that link
after restart and strips credentials and query parameters. See
[`node-red-health-heartbeat.md`](node-red-health-heartbeat.md) for the shipped
flow's purpose and configuration.

When `NODE_RED_ADMIN_TOKEN` has `flows.write`, `NODE_RED_EVENT_TOKEN` is set,
and a flow has a unique `tabId` in `NODE_RED_FLOW_ALLOWLIST`, NOVA can add one
of three fixed templates after fresh DANGEROUS confirmation. “Foutmelding” adds a
Catch node, fixed JSONata Change node, and `NOVA melding`; it reports catchable
errors from the selected tab, not runtime crashes or errors that a node only
writes to its log. “Offline-melding” adds a scoped Status node, a filter for
`disconnected`, `offline`, or `error`, a fixed JSONata formatter, and `NOVA
melding`. The status watcher is scoped to existing nodes in the selected tab.
NOVA creates no Function-node code or arbitrary nodes. The Node-RED revision is
checked before deployment and every new node is verified afterward. The
Settings flow list offers these templates. “Ochtendbriefing” and “Avondoverzicht”
add a daily cron Inject, a fixed request to NOVA's normal chat route, and a
bounded alert to NOVA's active clients. Settings defaults to 07:30 and 20:30 and
lets the user choose the local time before confirmation. The evening overview
uses up to 12 successful action names and times from NOVA's local action log,
open lists, timers, alerts, and tomorrow's appointments. It never includes
action arguments or results and does not infer details from tool names. An open, unpaused,
idle NOVA helper speaks the summary (up to 360 characters); quiet hours leave it visible but silent.
The regular dashboard does not speak it. If the helper is busy or absent, the
summary is not spoken later. Agenda content is
included only when an agenda integration is available. Arbitrary flow
generation and backup-specific failure detection remain unsupported.
