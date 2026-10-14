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
flows. NOVA's Settings page shows tab names, counts and validated fixed briefing schedules. An
explicit PIN/admin-protected download can export validated live flows as a
bounded Node-RED JSON array; the server rejects credential fields and likely embedded
secrets. Review the file before placing it in a repository. NOVA does not write
live flows into the tracked deployment seed.

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
add the durable `NOVA briefing` node. Settings defaults to07:30 and20:30 and
lets the user choose the local time before confirmation. The evening overview
uses up to12 successful action names and times from NOVA's local action log,
open lists, timers, alerts and tomorrow's appointments; arguments/results are
excluded. Daily slots catch up within four hours, pending replies survive
restarts and bounded retries reuse the same acceptance ID. Speech follows the
existing briefing, presence, focus, quiet-hour and claim settings. Restarted
history stays silent; physical receipt is not guaranteed.

Existing fixed briefing schedules appear in the flow inventory. Changing their
time or IANA timezone uses a dedicated DANGEROUS action with fresh confirmation,
whole-flow revision checks and exact post-write verification. Empty daily time
keeps event triggers and disables the daily schedule. This operation does not
require an executable HTTP-flow mapping. It sends the configured admin bearer
when present; a protected Node-RED API still rejects missing/invalid credentials.
Only the local Node-RED service is reachable, and no flow contents or credentials
are shown. Other flow creation, arbitrary code generation and backup-specific
failure detection remain unsupported.
