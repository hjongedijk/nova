# `node-red-contrib-nova`

NOVA ships five custom Node-RED nodes in
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
| **NOVA briefing**    | Daily time or stable `msg.novaEventId`               | Fixed read-only morning/evening summary, durable retries and idempotent feed acceptance.                                              |
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

The `NOVA vraag` editor has an opt-in **proactive** mode for scheduled flows.
It uses a separate bearer-protected API route, exposes only enabled
`READ_ONLY` tools, and rejects a tool if preparation raises its effective risk.
It cannot receive attachments or a user's chat session. NOVA-generated
briefing templates now use the durable `NOVA briefing` node. Existing ordinary ask
nodes keep regular chat behavior unless you enable proactive mode yourself.

Run `npm test --prefix deploy/nodered/node-red-contrib-nova` for node behavior.
`node scripts/test-nodered-flows.mjs` starts an isolated Node-RED 4.1 container,
seeds the package, imports the flows and checks the Admin API for all five
registered node types. `node scripts/check-nodered-flows.mjs` scans flow JSON for
secret-like values.

## Durable briefings

`NOVA briefing` owns its schedule and notification delivery. Set a daily `HH:mm`
and IANA timezone, or leave the time empty for events only. Each event must have a
stable `msg.novaEventId` (1–80 letters, digits, dots, colons, underscores or
hyphens). Payload text cannot change the fixed prompt, model, URL or tools.
Do not connect its output to a notification node: it has already submitted the
alert. The output is an acknowledgement, not an exactly-once action trigger.

Pending runs and sanitized replies live in private 0600 files under Node-RED's
`/data/.nova-workflows`. Up to 32 jobs are retained per node; deduplication keeps
at least seven days of history. A full queue rejects new events. Daily slots
catch up within four hours, including after a restart, and a repeated autumn
clock slot runs once. A changed schedule cancels older pending scheduled runs. Stable-ID event runs
and their deduplication survive clock/timezone edits; changing briefing kind
cancels pending runs instead of executing them under different settings. Corrupt state is never
silently overwritten.

Each model/delivery phase has at most six attempts with exponential waits from
30 seconds to 15 minutes. Runs expire after four hours. A saved reply is reused
when delivery fails. The API accepts a fixed workflow ID in a separate bounded
journal (`workflow-feed.json`, latest 200 acceptances) before dispatch. Lost
acknowledgements retry that ID. Restart restores visible history silently;
native/audio delivery is at-most-once, so a crash after acceptance can suppress
playback. Physical receipt is not guaranteed. Ordinary chat is never replayed.

The node's status shows pending, expired or storage/connection failure. Repair
storage or connectivity to resume within the bounded window. Removing the node
stops its work; retained state supports redeploying the same node ID.

`node scripts/test-briefing-runtime.mjs` uses a cached Node-RED image, disabled
network and isolated data. It proves automatic schedule/event triggers, temporary
503 recovery across a restart, lost-acknowledgement reply reuse and no replay
after another restart. Its synthetic API is not live provider/audio evidence.

Settings → Automation → Flows shows existing fixed morning/evening schedules.
Change the daily time/timezone or select event-only operation, then approve the
specific fresh confirmation. Concurrent flow edits invalidate that confirmation;
reload before retrying. Only `time` and `timezone` on the selected existing
`nova-briefing` node can change. Other nodes and credentials are preserved.

Module0.1.5 upgrades known v1 event ownership to its v2 journal before making
network calls. Deploy/restart this module with existing schedules unchanged
before the first schedule edit. Existing event IDs remain valid and deduplicated.
An old v1 event with an unmatched schedule fingerprint cannot prove its original
kind; it is retained as failed instead of executing under an inferred identity.

Rollback: retain module0.1.5 if rolling the NOVA API back to29; its workflow
endpoint and acceptance IDs remain compatible. Module0.1.4 cannot read v2
outboxes. Do not downgrade that module against upgraded data. A full runtime
rollback instead needs the matching private Node-RED backup, with any newer
work explicitly reconciled first; never replace live data blindly.
