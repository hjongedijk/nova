# Tools and safety

NOVA does things through **tools**: small, typed functions the language model may call (read a Proxmox guest, turn on a lamp, set a timer, search the web). The model never touches a device or service directly. Every call goes through one place, `ToolsService` (`apps/api/src/tools/tools.service.ts`), which decides whether and how it runs.

## Tool sources

A tool source is a class marked `@ToolSourceProvider()` that offers tool definitions; the registry discovers them by itself. Around a hundred tools exist in total. The list is also available at `GET /api/tools`, including tools that are currently off.

| Source           | Tools                                                                                                                                                                                                          | Needs                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `nova`, `system` | `system_integrations`, `system_time`                                                                                                                                                                           | nothing                              |
| `world`          | `weather_forecast`, `web_search`, `web_read`, `wikipedia`, `news_headlines`, `currency_convert`, `air_quality`, `market_rates`, `iss_position`, `moon_phase`, `calculate`                                      | internet                             |
| `planning`       | `timer_set`, `timer_list`, `timer_cancel`, `list_add`, `list_show`, `list_remove`, `list_clear`, `daily_briefing`                                                                                              | nothing                              |
| `checks`         | `alerts_list`, `network_check`                                                                                                                                                                                 | nothing (see `JARVIS_CHECK_TARGETS`) |
| `memory`         | `memory_search`, `memory_remember`, `memory_forget`                                                                                                                                                            | memory backend for long-term use     |
| `proxmox`        | `proxmox_status`, `proxmox_nodes`, `proxmox_guests`, `proxmox_storage`, `proxmox_tasks`, `proxmox_guest_status`, `proxmox_start_guest`, `proxmox_stop_guest`, `proxmox_shutdown_guest`, `proxmox_reboot_guest` | `PROXMOX_*`                          |
| `home-assistant` | lights, switches, climate, scenes, scripts, media players and Sonos: `home_status`, `ha_*`, `media_*`, `sonos_*`, `music_play`                                                                                 | `HOME_ASSISTANT_*`                   |
| `windows`        | `windows_status`, `windows_open_app`, `windows_open_url`, `windows_play_youtube`, `windows_search`, `windows_displays`, `windows_wallpaper`, `windows_close_app`, `windows_lock`                               | Windows agent                        |
| `browser`        | `browser_status`, `browser_search`, `browser_open`, `browser_read`, `browser_click`, `browser_click_confirmed`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_tab`               | Windows agent                        |
| `termix`         | `termix_status`, `termix_hosts`, `termix_run_command`                                                                                                                                                          | `TERMIX_*`                           |
| `pangolin`       | `pangolin_orgs`, `pangolin_sites`, `pangolin_resources`                                                                                                                                                        | `PANGOLIN_*`                         |
| `omniroute`      | `omniroute_status`, `omniroute_agent_skills`                                                                                                                                                                   | `OMNIROUTE_ADMIN_PASSWORD`           |
| `mcp`            | `mcp_<server>_<tool>` from your MCP servers (`deploy/mcp-servers.json`, or `mcp-servers.json` in the data folder)                                                                                              | the servers you configure            |
| `skills`         | `skill_<id>` for each webhook skill you made in Settings                                                                                                                                                       | Settings screen                      |

A tool whose integration is not configured stays in the list but is disabled; calling it answers "Unknown tool or integration unavailable". You can also switch tools or whole ability groups off in **Settings, Wat NOVA kan**, and `JARVIS_EXTENSIONS=false` switches off every source except NOVA's own.

The default MCP list ships three servers installed in the image: `sequential-thinking` and `context7` (both `READ_ONLY`) and `filesystem` restricted to `/data/workspace` (`CONFIRM`). Servers whose `${VAR}` environment references are unset stay offline.

## Risk levels

Each tool declares a risk. A source can refine it per call (for example Home Assistant decides from the exact device and service).

| Risk        | Meaning                                                                                                                                      | Behaviour                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `READ_ONLY` | Reads or calculates, changes nothing.                                                                                                        | Runs immediately.                                                                      |
| `SAFE`      | Changes something minor and easy to undo (timer, light, volume, opening a program, a browser click).                                         | Runs immediately; with `JARVIS_AUTO_EXECUTE_SAFE_ACTIONS=false` it needs confirmation. |
| `CONFIRM`   | Hard to undo or with real effects (VM power, closing programs, locking the screen, scenes, running a command over SSH, forgetting a memory). | Always needs confirmation.                                                             |
| `DANGEROUS` | Security or safety relevant.                                                                                                                 | Always needs confirmation.                                                             |

Examples of how risk is decided:

- **Proxmox**: starting, stopping, shutting down and rebooting a guest are `CONFIRM`; everything else is read-only.
- **Home Assistant** (`home/risk.ts`): unlocking a lock is `DANGEROUS`; locks, covers, scenes, scripts, toggles, announcements and Sonos grouping are `CONFIRM`; a switch whose name looks like a server, router, NAS, pump, heater, boiler or outlet is `DANGEROUS`; large temperature changes (more than 2 degrees, or outside 16 to 26) and large volume jumps are `CONFIRM`; everything else is `SAFE`.
- **Windows**: opening apps, URLs, YouTube, search and the wallpaper are `SAFE`; closing programs and locking are `CONFIRM`. In the browser, normal clicks and typing are `SAFE`; a click on a button that buys, pays, orders, donates, subscribes or deletes must go through `browser_click_confirmed` (`CONFIRM`).
- **MCP servers**: a tool that declares `readOnlyHint` is `READ_ONLY`; otherwise the server's `risk` in the config applies, default `CONFIRM`.
- **Your own webhook skills** declare `READ_ONLY`, `SAFE` or `CONFIRM`.

### The master switch

`JARVIS_ENABLE_ACTIONS` defaults to `false`. While it is `false`, every tool whose risk is not `READ_ONLY` is refused ("Device actions are disabled until integration onboarding is complete"), except the `memory_*` tools. NOVA is therefore read-only until you set it to `true`.

## Confirmation flow

1. The model calls a tool that needs confirmation. Nothing runs. NOVA creates a pending confirmation and answers with a question ("Zal ik ...?"). The interface shows a confirmation card.
2. The confirmation is valid for **60 seconds**, **one per session** and can be used **once**. A new message that is not an answer cancels it.
3. You answer by voice or text with a plain "ja", "ok", "doe maar", "akkoord", "yes", "confirm" ... or "nee", "laat maar", "annuleer", "no" ..., or press the buttons (`POST /api/actions/confirm` with the confirmation id). A "ja" with nothing waiting is just conversation.
4. On approval the call is re-checked: the tool, session, arguments and risk must match exactly what was asked, then it runs. Expiry, rejection and cancellation are written to the action log.

The helper pill and the Windows wallpaper use the same confirmations.

## What happens to every call

In order, for each tool call:

1. The tool must exist and be enabled.
2. **Argument cleaning (coercion)**: models fill optional fields with `""` or `null`, send numbers as text, and add fields that were never asked for. NOVA drops empty optional values, converts numeric and boolean text, rounds non-integers for integer fields, fixes the case of enum values, drops unknown fields (except numeric id-like ones such as `vmid`, which are kept so the meaning does not change) and removes the `reason` field that OmniRoute's Gemini adapter adds to empty schemas.
3. **Validation** against the tool's JSON schema (Ajv). Invalid arguments fail with `Invalid tool arguments`.
4. The source may **prepare** the call: decide the real risk, resolve names, refuse ambiguous requests.
5. The master switch and the confirmation rules above.
6. For anything that is not read-only, a log line `execution_started` is written **before** the action, so the call is not made if the log cannot be written.
7. **Execution** with a timeout of at most 60 seconds (`JARVIS_TOOL_TIMEOUT_MS`).
8. The result is sanitised, logged, remembered in the session context and a completion event is published on MQTT (`jarvis/events/tool`).

Tools may report `verified`: `true` when NOVA checked the effect (for example by reading the state back), `null` when it was done but could not be checked. A model may run at most eight tool calls from one reply; extra calls are dropped. The number of model rounds per message is limited by `JARVIS_MAX_TOOL_ITERATIONS`.

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

- **`web_read` and other world tools** (`net-guard.ts`): only `http` and `https`, only ports 80 and 443, no credentials in the URL, no `localhost`, `.local`, `.internal` or dotless names. Private, loopback, link-local, carrier-grade NAT, multicast and reserved IPv4 ranges and the IPv6 equivalents are refused. Addresses are checked **at connect time** (a custom DNS lookup), so an answer cannot change between check and use; up to three redirects are followed and every hop is checked again. Responses are capped (1.5 MB by default) and have a timeout.
- **Webhook skills and custom panels** (`safe-request.ts`): the same rules by default. The owner can tick "lokaal netwerk toestaan" (allow local network) per skill or panel to reach something on the LAN, with other ports; even then, this machine itself (`localhost`, loopback, `169.254.*` including cloud metadata, multicast) and NOVA's own internal services (`omniroute`, `qdrant`, `mqtt`, `node-red`, the NOVA container names) stay forbidden. Response size is capped (200 KB by default).
- **Windows agent**: NOVA sends only an app name or an `http(s)` URL; the allow-list lives on the PC.

## Free-model routing policy

Language-model requests only go out when the free route is verified. This fails closed. See [OmniRoute and free routing](omniroute.md).

## What NOVA does not do

- **There is no user login.** The chat, tools, memory, audit and dashboard API endpoints are open to anyone who can reach NOVA; only the settings API can be protected with `NOVA_ADMIN_PIN` (plus an `x-nova-admin` header on writes so a cross-site form cannot change settings). Run NOVA on a trusted network, or put a reverse proxy with authentication or a VPN in front of it. Do not expose the ports directly to the internet.
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
