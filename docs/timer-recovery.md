# Timer recovery

NOVA persists an expired timer before handing it to the notification feed. Expiry moves the timer into a bounded outbox in the existing private planning state file. A single feed consumer accepts the event into `timer-feed.json`; only successful acceptance permits removing the pending entry.

A stable timer ID and deadline identify each delivery. Restarting between acceptance and acknowledgement does not create a second feed notice. Accepted timer history reappears silently after restart. Temporary storage or consumer failures retain pending entries and retry with exponential delays capped at sixty seconds. At most 100 expired notifications wait in the outbox; additional due timers remain active until capacity is available.

The acceptance journal retains at most 200 notices, while the visible feed restores the latest fifty. Both state and journal writes flush their temporary file and parent directory. The journal uses mode 0600. Unreadable history prevents acknowledgement rather than silently deleting pending timers. Repair the private history file before retries can resume; do not erase it as an automatic cleanup action.

This guarantee covers durable feed acceptance. Windows notifications and MQTT remain best-effort transports; they lack acknowledgements that would prove exactly-once physical delivery or audible playback. Recovery restores history without replaying speech. Failed acceptance does not consume the speech budget.

The existing planning filename and MQTT topics remain compatible with older deployments. Existing active timers and lists are preserved; old state files acquire an empty outbox when read. Before rollback, retain both private files so a later upgraded process can resume pending work.

Validation: planning/feed regressions cover transient delivery failure, full storage, acknowledgement failure, restart deduplication, corrupt-history repair, retry bounds and capacity. After building the API, run `node scripts/test-timer-recovery-runtime.mjs` under Node 24. It uses three separate processes and a private temporary directory to prove background expiry, restart recovery and silent subsequent restoration without contacting a Windows PC or MQTT broker.
