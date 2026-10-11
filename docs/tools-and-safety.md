# Tools and safety

NOVA does things through **tools**: small, typed functions the language model may call (read a Proxmox guest, turn on a lamp, set a timer, search the web). The model never touches a device or service directly. Every call goes through one place, `ToolsService` (`apps/api/src/tools/tools.service.ts`), which decides whether and how it runs.

## Tool sources

A tool source is a class marked `@ToolSourceProvider()` that offers tool definitions; the registry discovers them by itself. Around a hundred tools exist in total. The list is also available at `GET /api/tools`, including tools that are currently off.

| Source           | Tools                                                                                                                                                                                                          | Needs                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `nova`, `system` | `system_integrations`, `system_time`                                                                                                                                                                           | nothing                                                                                              |
| `world`          | `weather_forecast`, `web_search`, `web_read`, `wikipedia`, `news_headlines`, `currency_convert`, `air_quality`, `market_rates`, `iss_position`, `moon_phase`, `calculate`                                      | internet                                                                                             |
| `planning`       | `timer_set`, `timer_list`, `timer_cancel`, `list_add`, `list_show`, `list_remove`, `list_clear`, `daily_briefing`                                                                                              | Home Assistant todo lists by exact name (when visible); see [planning lists](planning-lists.md)      |
| `checks`         | `alerts_list`, `network_check`                                                                                                                                                                                 | nothing (see `NOVA_CHECK_TARGETS`)                                                                   |
| `memory`         | `memory_search`, `memory_remember`, `memory_forget`                                                                                                                                                            | memory backend for long-term use                                                                     |
| `documents`      | `documents_list`, `documents_search`, `documents_forget`                                                                                                                                                       | verified-free embeddings and separate Qdrant collection; see [document library](document-library.md) |
| `proxmox`        | `proxmox_status`, `proxmox_nodes`, `proxmox_guests`, `proxmox_storage`, `proxmox_tasks`, `proxmox_guest_status`, `proxmox_start_guest`, `proxmox_stop_guest`, `proxmox_shutdown_guest`, `proxmox_reboot_guest` | `PROXMOX_*`                                                                                          |
| `home-assistant` | lights, switches, climate, scenes, scripts, media players and Sonos: `home_status`, `ha_*`, `media_*`, `sonos_*`, `music_play`                                                                                 | `HOME_ASSISTANT_*`                                                                                   |
| `windows`        | `windows_status`, `windows_open_app`, `windows_open_url`, `windows_play_youtube`, `windows_search`, `windows_displays`, `windows_wallpaper`, `windows_close_app`, `windows_lock`                               | Windows agent                                                                                        |
| `browser`        | `browser_status`, `browser_search`, `browser_open`, `browser_read`, `browser_click`, `browser_click_confirmed`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_tab`               | Windows agent                                                                                        |
| `termix`         | `termix_status`, `termix_hosts`, `termix_run_command`                                                                                                                                                          | `TERMIX_*`                                                                                           |
| `pangolin`       | `pangolin_orgs`, `pangolin_sites`, `pangolin_resources`                                                                                                                                                        | `PANGOLIN_*`                                                                                         |
| `omniroute`      | `omniroute_status`, `omniroute_agent_skills`                                                                                                                                                                   | `OMNIROUTE_ADMIN_PASSWORD`                                                                           |
| `mcp`            | `mcp_<server>_<tool>` from your MCP servers (`deploy/mcp-servers.json`, or `mcp-servers.json` in the data folder)                                                                                              | the servers you configure                                                                            |
| `skills`         | `skill_<id>` for each webhook skill you made in Settings                                                                                                                                                       | Settings screen                                                                                      |

A tool whose integration is not configured stays in the list but is disabled; calling it answers "Unknown tool or integration unavailable". You can also switch tools or whole ability groups off in **Settings, Wat NOVA kan**, and `NOVA_EXTENSIONS=false` switches off every source except NOVA's own.

Before adding or enabling a tool, complete the [new-tool checklist](new-tool-checklist.md). It records the risk decision, confirmation and audit behavior, secret handling, network boundary and required regression evidence.

The default MCP list ships three servers installed in the image: `sequential-thinking` and `context7` (both `READ_ONLY`) and `filesystem` restricted to `/data/workspace` (`CONFIRM`). Servers whose `${VAR}` environment references are unset stay offline.

## Risk levels

Each tool declares a risk. A source can refine it per call (for example Home Assistant decides from the exact device and service).

| Risk        | Meaning                                                                                                                                      | Behaviour                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `READ_ONLY` | Reads or calculates, changes nothing.                                                                                                        | Runs immediately.                                                                    |
| `SAFE`      | Changes something minor and easy to undo (timer, light, volume, opening a program, a browser click).                                         | Runs immediately; with `NOVA_AUTO_EXECUTE_SAFE_ACTIONS=false` it needs confirmation. |
| `CONFIRM`   | Hard to undo or with real effects (VM power, closing programs, locking the screen, scenes, running a command over SSH, forgetting a memory). | Always needs confirmation.                                                           |
| `DANGEROUS` | Security or safety relevant.                                                                                                                 | Always needs confirmation.                                                           |

Examples of how risk is decided:

- **Proxmox**: starting, stopping, shutting down and rebooting a guest are `CONFIRM`; everything else is read-only.
- **Home Assistant** (`home/risk.ts`): unlocking a lock is `DANGEROUS`; locks, covers, scenes, scripts, toggles, announcements and Sonos grouping are `CONFIRM`; a switch whose name looks like a server, router, NAS, pump, heater, boiler or outlet is `DANGEROUS`; large temperature changes (more than 2 degrees, or outside 16 to 26) and large volume jumps are `CONFIRM`; everything else is `SAFE`.
- **Windows**: opening apps, URLs, YouTube, search and the wallpaper are `SAFE`; closing programs and locking are `CONFIRM`. In the browser, normal clicks and typing are `SAFE`; a click on a button that buys, pays, orders, donates, subscribes or deletes must go through `browser_click_confirmed` (`CONFIRM`).
- **MCP servers**: a tool that declares `readOnlyHint` is `READ_ONLY`; otherwise the server's explicit `risk` in the config applies. A server with a missing or invalid risk is not started. Set unreviewed servers to `CONFIRM` explicitly.
- **Your own webhook skills** declare `READ_ONLY`, `SAFE` or `CONFIRM`.

### The master switch

`NOVA_ENABLE_ACTIONS` defaults to `false`. While it is `false`, every tool whose risk is not `READ_ONLY` is refused ("Device actions are disabled until integration onboarding is complete"), except the `memory_*` tools. NOVA is therefore read-only until you set it to `true`.

## Confirmation flow

1. The model calls a tool that needs confirmation. Nothing runs. NOVA creates a pending confirmation and answers with a question ("Zal ik ...?"). The interface shows a confirmation card.
2. The confirmation is valid for **60 seconds**, **one per session** and can be used **once**. A new message that is not an answer cancels it.
3. You answer by voice or text with a plain "ja", "ok", "doe maar", "akkoord", "yes", "confirm" ... or "nee", "laat maar", "annuleer", "no" ..., or press the buttons (`POST /api/actions/confirm` with the confirmation id). A "ja" with nothing waiting is just conversation.
4. On approval the call is re-checked: the tool, session, arguments and risk must match exactly what was asked, then it runs. Expiry, rejection and cancellation are written to the action log.

The helper pill and the Windows wallpaper use the same confirmations.

### Multi-step requests

For requests such as preparing a film night, NOVA can call several enabled tools in sequence and use each result to decide the next step. The chat shows a short, numbered activity hint and voice gives a brief explanation of the current work. This is a sequence of ordinary tool calls, not an atomic transaction: each call keeps its own risk check, and a call that needs confirmation pauses the sequence until the user responds. NOVA reports what was actually checked or accepted; an accepted action is not described as verified unless the integration confirms it.

## What happens to every call

In order, for each tool call:

1. The tool must exist and be enabled.
2. **Argument cleaning (coercion)**: models fill optional fields with `""` or `null`, send numbers as text, and add fields that were never asked for. NOVA drops empty optional values, converts numeric and boolean text, rounds non-integers for integer fields, fixes the case of enum values, drops unknown fields (except numeric id-like ones such as `vmid`, which are kept so the meaning does not change) and removes the `reason` field that OmniRoute's Gemini adapter adds to empty schemas.
3. **Validation** against the tool's JSON schema (Ajv). Invalid arguments fail with `Invalid tool arguments`.
4. The source may **prepare** the call: decide the real risk, resolve names, refuse ambiguous requests.
5. The master switch and the confirmation rules above.
6. For anything that is not read-only, a log line `execution_started` is written **before** the action, so the call is not made if the log cannot be written.
7. **Execution** with a timeout of at most 60 seconds (`NOVA_TOOL_TIMEOUT_MS`).
8. The result is sanitised, logged, remembered in the session context and a completion event is published on MQTT (`jarvis/events/tool`).

Tools may report `verified`: `true` when NOVA checked the effect (for example by reading the state back), `null` when it was done but could not be checked. A model may run at most eight tool calls from one reply; extra calls are dropped. The number of model rounds per message is limited by `NOVA_MAX_TOOL_ITERATIONS`.

The dashboard polls a few read-only tools (`proxmox_guests`, `proxmox_storage`, `timer_list`, `list_show`, `alerts_list`) quietly: no log entries and no conversation context.

## Audit log

`actions.jsonl` in the data folder holds one JSON object per line, append-only, file mode 0600: id, time, session, tool, arguments, risk, confirmation state (`not_required`, `pending`, `confirmed`, `rejected`, `expired`, `cancelled`), the result, verification and duration. Everything is sanitised before it is written. The newest entries are shown in the interface and at `GET /api/audit?limit=...` (at most 500, from the last 2 MB of the log).

## Secret sanitising

`core/security/sanitize.ts` is applied to everything NOVA stores, logs, streams to the browser or hands to the model:

- the values of all environment variables whose name contains `KEY`, `SECRET`, `TOKEN` or `PASSWORD`,
- `Bearer ...` and `PVEAPIToken=...` values, `sk-...` style keys and JWTs,
- text such as "password: ...", "api key is ...",
- object fields named like `authorization`, `password`, `secret`, `token`, `api key` or `headers` are removed (token-usage counters are kept).

Rejected memory candidates are logged only as `[rejected memory candidate]`, and the long-term memory refuses content that looks like credentials. Webhook skills keep secret header values in `settings.json` (mode 0600); they are never sent back to the browser.

## Outbound requests: net guard

Tools that fetch what the model (or a user-made skill) asks for are a way into a LAN, so they go through `core/security`:

- **User/model-selected URLs** (`web_read`, `web_search`, `net-guard.ts`): only `http` and `https`, only ports 80 and 443, no credentials, `localhost`, `.local`, `.internal` or dotless names. Private, loopback, link-local, carrier-grade NAT, multicast, documentation and reserved IPv4/IPv6 ranges are refused. DNS answers are checked **at connect time**; a mixed public/private answer fails closed. Up to three redirects are followed and every hop is checked again. Responses are capped (1.5 MB by default) and have a timeout.
- **Fixed JSON APIs** (`WorldService`): HTTPS only and a pinned hostname allowlist; redirects are rejected. Bodies are capped at 1.5 MB before JSON parsing. User input may fill only validated query fields, never the host. These APIs do not accept arbitrary proxy URLs.
- **Webhook skills and custom panels** (`safe-request.ts`): the same rules by default. The owner can tick "lokaal netwerk toestaan" (allow local network) per skill or panel to reach something on the LAN, with other ports; even then, this machine itself (`localhost`, loopback, `169.254.*` including cloud metadata, multicast) and NOVA's own internal services (`omniroute`, `qdrant`, `mqtt`, `node-red`, the NOVA container names) stay forbidden. Response size is capped (200 KB by default).
- **Windows agent**: NOVA sends only an app name or an `http(s)` URL; the allow-list lives on the PC.

## Free-model routing policy

Language-model requests only go out when the free route is verified. This fails closed. See [OmniRoute and free routing](omniroute.md).

## What NOVA does not do

- **App access is optional and off by default.** Set `NOVA_APP_TOKEN` to a long random secret to gate every API route, including chat, tools, memory, audit, dashboards and settings. The browser exchanges it for a 12-hour `Secure`, `HttpOnly`, `SameSite=Strict` cookie; the token is not stored in browser storage. Five failed unlocks from one observed client address are blocked for five minutes. Writes require an `https://` same-host `Origin`. The health probe and access bootstrap remain public; Node-RED event ingress and the restricted proactive ask route require their bearer token. `NOVA_ADMIN_PIN` remains an additional settings barrier.
- **Use HTTPS outside a trusted LAN.** A reverse proxy must terminate TLS, preserve the external `Host`, overwrite forwarded headers, and proxy only to the NOVA API. Restrict/firewall host ports `8080` and `8443` so they cannot bypass proxy authentication or TLS; the app does not trust client-supplied `X-Forwarded-*` headers. Rate-limit `/api/access/unlock` at the proxy too: NOVA sees all clients as the proxy unless the connection is bound and configured otherwise. Never expose NOVA or its service ports directly to the internet.
- The other containers in the compose file (OmniRoute dashboard on 20128, MQTT on 1883, Node-RED on 1880) are published on the host too and run as root; restrict them with your firewall. The compose file ships no Mosquitto configuration, so authentication on MQTT is up to you.
- Confirmation protects against the model acting alone; it is not a substitute for network access control.

## Chat file attachments

Use the paperclip beside the chat input for PDF, Word (.docx), PNG/JPEG/WebP/GIF images, text, source code, CSV, JSON, Markdown and logs. Attach up to five files, at most 10 MiB each and 20 MiB in total. Click a selected file to remove it. Files can accompany a question or be sent on their own. A failed request keeps the draft and files so you can retry.

PDF and DOCX body text are extracted locally in an isolated, time-limited worker. Images are sent as vision input through the existing OmniRoute free route; the chosen model must support images. NOVA does not switch to a paid provider to read them. Legacy .doc, Excel/PowerPoint files, archives and audio/video are unsupported; export documents as PDF and spreadsheets as CSV.

NOVA sees at most the first 24,000 characters of each text document and at most 100 PDF pages. If a file is excerpted, chat displays a notice and the model is told it has an excerpt. Scanned PDFs without text need an image of the relevant page; there is no OCR step. Document layouts, drawings and embedded DOCX images are not preserved.

Files are held in memory during the request, never saved to the server filesystem or as file contents in conversation history. The browser history shows file names. To ask another question about a file in a later turn, attach it again.

## Conversation style

NOVA aims to be a calm, attentive personal assistant: understand the intention, act within the request, and explain the useful result. It can acknowledge a difficult day without launching unrelated tools, and suggest a relevant next step without appending an offer to every answer. Actions and claims of success still follow the backend's existing verification and confirmation rules.

Typed chat allows useful lists, links, code and fuller explanations. Speech recognition and the wake word identify voice turns, which favour natural spoken sentences. Tool results preserve that turn's style rather than forcing every answer into four sentences. The model receives the last six conversation turns (twelve messages) for continuity, plus relevant older memory. The user's own persona settings remain in effect.

## Scoped standing approvals

“Altijd” on a fresh confirmation grants permission only for a `CONFIRM` tool with exactly the same normalized arguments. `DANGEROUS` never qualifies. The backend still validates arguments, prepares the call, determines its actual risk and checks action availability before considering a rule. Unknown fields cannot reuse a rule. The confirmation remains session-bound, single-use and valid for 60 seconds.

Rules store argument and schema/execution fingerprints, a sanitized display scope and creation time. Changing parameters, risk, source identity or schema requires a new confirmation. Webhook skill execution settings contribute a private revision; changing its endpoint/body/credentials invalidates the rule. MCP connections receive a private generation revision, so reconnecting invalidates existing permissions. Private revision fields never reach the model or public tool metadata.

Creation, automatic execution and revocation are audited; log failure prevents grant creation/execution. Every reused approval is marked in the live ticker. Revoke individual rules in Settings → Behavior. The settings API only lists/revokes rules; backup export/import cannot create them. Rules are limited to 100 and never store raw secrets. Permission applies across local conversation sessions until revoked, changed or invalidated.

## Personal settings through chat

NOVA can replace personal conversation rules, create an instruction skill and enable or disable an existing instruction skill through dedicated settings tools. Each change requires a new, session-bound confirmation valid for 60 seconds. The confirmation shows the proposed text or skill identifier; these tools never offer or reuse “Altijd”. Changing the persona or skill configuration invalidates a pending approval. Changes use the same validation and storage as the settings page and are audited.

The read-only skill list exposes identifiers, names, types, enabled state and versions, without credentials or HTTP bindings. Chat cannot create or enable webhook bindings, edit service credentials, change access controls or add executable code through these settings tools. Manage those bindings on the settings page. Webhook skills and custom panels reject `x-nova-admin` and `x-nova-pin` headers, including legacy stored headers at request time.

Night mode and model selection through chat are still pending their corresponding features. Instruction skills describe a workflow using existing tools; they do not grant new permissions.

## Native gateway skill modes

The Models settings page can change the mode of an existing NOVA-owned native OmniRoute skill. Native skills may execute handler code inside the gateway; enabling or automatic mode is DANGEROUS, disabling is CONFIRM. Preparation performs no write. The PIN-guarded settings API uses a separate server-created confirmation session, a 60-second single-use approval and no standing permission. Shared/global and other-owner skills cannot be changed through this endpoint. There is no chat tool for it.

A private revision binds the approval to ownership, name, handler, schema, mode and update time. The server checks the revision again before writing and refuses overlapping changes to the same skill. The upstream PUT echo is insufficient: NOVA checks actual mode/enabled and execution binding through the read-only database. A failure leaves persistence unknown; audit completion failure after verified persistence is reported as a warning. The upstream runtime cache may take a minute to reflect a saved change. External gateway administrators are not covered by NOVA's local in-flight guard; changed execution bindings fail post-write verification.
