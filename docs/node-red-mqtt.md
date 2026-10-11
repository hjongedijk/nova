# Node-RED, MQTT and HTTP boundaries

This describes the current NOVA implementation. Node-RED is required by Docker Compose and reachable only on the internal production network; development publishes port 1880 on localhost only. NOVA checks the local Admin API for flow-tab counts. The PIN-guarded Settings inventory shows only tab ID/name/status/node count and API revision, never flow definitions or credentials.

Trusted flows can send plain alerts or runtime errors to `POST /api/integrations/node-red/events`. Set `NODE_RED_EVENT_TOKEN` to the same random value for NOVA and Node-RED. Send `Authorization: Bearer <token>` and a JSON body of one of these forms:

```json
{"type":"alert","title":"Back-up klaar","detail":"Nachtelijke back-up voltooid","severity":"info"}
{"type":"runtime_error","detail":"Flow back-up gaf een fout","flowId":"tab.123"}
```

`flowId` is optional and accepts only a short Node-RED ID. When supplied, the system panel links to that tab in NOVA's flow inventory. Keep message text free of secrets; audit stores only event type and severity.

The endpoint accepts only these event types, limits payloads to 4 KiB and 60 accepted events per minute, and records accepted event metadata without the message text or flow ID. Alerts enter the existing bounded notification feed. Runtime errors update the Node-RED health summary; an optional flow ID creates a link to NOVA's matching inventory entry. Event text is treated as untrusted display data; it cannot invoke tools or trigger an AI response. Node-RED's Admin API still has no latest-runtime-error endpoint, so flows must explicitly report errors. The packaged `node-red-contrib-nova` nodes remain unimplemented.

Outbound triggers are available only for flows listed in `NODE_RED_FLOW_ALLOWLIST`; NOVA posts to the fixed path `/_nova/flow/<id>` with `NODE_RED_FLOW_TOKEN`. The flow must have an HTTP-in node on that path, validate the bearer token, return a JSON result through an HTTP Response node, and finish within ten seconds. NOVA limits input to 4 KiB and 32 top-level fields, accepts at most 16 KiB of response JSON and returns up to 8 KiB of sanitized result text. Each flow's configured risk goes through NOVA's normal confirmation and audit path. Keep the token in the Node-RED environment, never in an exported flow.

For a built-in Node-RED Function node, set the request header before an HTTP Request node:

```js
msg.headers = { authorization: `Bearer ${env.get("NODE_RED_EVENT_TOKEN")}` };
msg.url = "http://nova:8080/api/integrations/node-red/events";
msg.method = "POST";
msg.payload = { type: "alert", title: "Flow klaar", severity: "info" };
return msg;
```

In development, point `msg.url` to the host's NOVA API address reachable from Node-RED. Do not put the token in a flow export or repository; use the environment variable.

## Current MQTT traffic

NOVA publishes a JSON envelope on the following allowlisted topics. Every payload has `type`, `source: "nova"`, `severity`, `timestamp` and sanitized `data` fields. NOVA does not subscribe to MQTT topics, so these topics do not provide a way to send commands or notifications into NOVA.

| Topic                        | Current publisher          | Data sent                                                                                                 |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `jarvis/status/api`          | MQTT connection lifecycle  | Retained `online` status and retained offline last will.                                                  |
| `jarvis/status/proxmox`      | Proxmox connection tracker | Retained `online` boolean after a Proxmox request.                                                        |
| `jarvis/events/tool`         | Tool runner                | Tool name, success flag and elapsed milliseconds; no tool arguments or result.                            |
| `jarvis/events/conversation` | Chat controller            | Session ID, response character count, selected model and elapsed milliseconds; no message or answer text. |
| `jarvis/events/timer`        | Timer scheduler            | Timer ID, label, fired-at timestamp and whether it was late. Treat the label as user-authored data.       |
| `jarvis/alerts`              | Checks/watchdog            | Alert ID, key, severity, title, detail and timestamp. Treat title and detail as potentially sensitive.    |
| `jarvis/events/proxmox`      | State/event store          | Proxmox state-change payloads from the watchdog.                                                          |
| `jarvis/events/system`       | State/event store          | System state-change payloads from the watchdog.                                                           |
| `jarvis/events/web`          | Allowlisted for future use | No current publisher.                                                                                     |
| `jarvis/status/node-red`     | Allowlisted for future use | No current publisher.                                                                                     |

`jarvis/events/proxmox`, `jarvis/events/system`, and `jarvis/alerts` carry more descriptive fields than the tool and conversation summaries. Restrict broker access and do not forward these payloads to public brokers or logs without reviewing their contents. The NOVA UI's recent-message view stores only a short summary, not the complete payload.

## Current HTTP traffic

The browser and helper use NOVA's HTTP API for chat, settings, status, and confirmed tool actions. NOVA can call only explicitly allow-listed Node-RED flow paths over authenticated HTTP; arbitrary URLs and generic proxying are not supported. The event callback uses `NODE_RED_EVENT_TOKEN`. Node-RED's own editor/API remains separate from NOVA's settings PIN and action-confirmation flow.

## Direction for future flow integration

- Keep MQTT for asynchronous status and event broadcasts. A subscriber may observe events but cannot command NOVA through this channel.
- Use a dedicated authenticated HTTP endpoint for a flow to request a NOVA action or deliver an event to NOVA. Bind each request to an allowlisted flow/action, validate a bounded schema, audit it, and use the normal risk/confirmation path for sensitive actions.
- Do not expose a generic HTTP proxy, arbitrary flow URL, or command-capable MQTT subscription. Add the endpoint and its actual event classes to this document when implemented.

These are design boundaries, not claims that the future endpoints already exist. See [tool safety](tools-and-safety.md) and [configuration](configuration.md) for network and broker configuration.
