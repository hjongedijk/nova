# Node-RED health heartbeat

NOVA checks the local Node-RED Admin API through `NodeRedHealth`. It reports
availability changes to the NOVA alert feed after the first successful or
failed sample; the initial sample is silent to avoid startup noise. The health
summary exposes only reachability, tab count, and explicitly reported runtime
errors, never flow contents or credentials.

The seeded **NOVA health heartbeat** flow checks `http://nova:8080/api/health`
every 60 seconds (first check after 15 seconds). Failed requests set an
in-memory outage flag. When the API responds again, the flow posts one recovery
alert to `/api/integrations/node-red/events`. NOVA being offline cannot receive
an outage alert; Node-RED records that condition locally and reports recovery.
The flag resets when Node-RED restarts.

The recovery callback reads `NODE_RED_EVENT_TOKEN` from Node-RED's runtime
environment. The value must match NOVA's setting and contain at least 32
characters. It is never stored in `flows.json`. Without a configured token,
checks continue and the callback is skipped. The flow uses only built-in
Node-RED nodes and performs no model calls or other actions.

The seed is copied only when the persistent `/data/flows.json` does not yet
exist. Existing installations can import `deploy/nodered/flows.json` through
the editor or deploy the flow manually; upgrades do not replace user flows.
