# Tools and unrestricted operation

**NOVA runs unrestricted and autonomous. It acts first and reports afterwards.** There is no PIN, no app login, no approval or confirmation step and no autonomy level: every tool executes at once and is only written to the audit log. Access control is the reverse proxy in front of NOVA (see [Access and exposure](#access-and-exposure)). If NOVA does something you did not want, tell it something is wrong and it learns from the correction (see [Learning and self-tuning](features.md#learning-and-self-tuning)).

NOVA does things through **tools**: small, typed functions the language model may call (read a Proxmox guest, turn on a lamp, set a timer, search the web). The model never touches a device or service directly. Every call goes through one place, `ToolsService` (`apps/api/src/tools/tools.service.ts`), which cleans and validates the arguments, runs the tool, logs it and checks the result.

## Tool sources

`system_time` reads one server-clock instant without network or storage access. Optional `timezone` is an IANA name; omitting it preserves the configured timezone. Existing `iso`, `timestamp`, `serverTimezone` and `local` fields remain available. `timezone` identifies the selected zone; `local.isoDate` and `local.timeWithSeconds` provide exact machine-readable values. Use `local.spoken` for rounded, natural Dutch time and the exact local fields when precision is requested.

A tool source is a class marked `@ToolSourceProvider()` that offers tool definitions; the registry discovers them by itself. Around a hundred tools exist in total. The list is also available at `GET /api/tools`, including tools that are currently off.

| Source           | Tools                                                                                                                                                                                                          | Needs                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `nova`, `system` | `system_integrations`, `system_time`                                                                                                                                                                           | nothing                                                                                                            |
| `world`          | `weather_forecast`, `web_search`, `web_read`, `wikipedia`, `news_headlines`, `currency_convert`, `air_quality`, `market_rates`, `iss_position`, `moon_phase`, `calculate`                                      | internet                                                                                                           |
| `planning`       | `timer_set`, `timer_list`, `timer_cancel`, `list_add`, `list_show`, `list_remove`, `list_clear`, `daily_briefing`                                                                                              | Home Assistant todo lists by exact name (when visible); see [planning lists](features.md#timers-lists-and-cooking) |
| `checks`         | `alerts_list`, `network_check`                                                                                                                                                                                 | nothing (see `NOVA_CHECK_TARGETS`)                                                                                 |
| `memory`         | `memory_search`, `memory_remember`, `memory_forget`                                                                                                                                                            | memory backend for long-term use                                                                                   |
| `documents`      | `documents_list`, `documents_search`, `documents_forget`                                                                                                                                                       | verified-free embeddings and separate Qdrant collection; see [document library](features.md#document-library)      |
| `proxmox`        | `proxmox_status`, `proxmox_nodes`, `proxmox_guests`, `proxmox_storage`, `proxmox_tasks`, `proxmox_guest_status`, `proxmox_start_guest`, `proxmox_stop_guest`, `proxmox_shutdown_guest`, `proxmox_reboot_guest` | `PROXMOX_*`                                                                                                        |
| `home-assistant` | lights, switches, climate, scenes, scripts, media players and Sonos: `home_status`, `ha_*`, `media_*`, `sonos_*`, `music_play`                                                                                 | `HOME_ASSISTANT_*`                                                                                                 |
| `windows`        | `windows_status`, `windows_open_app`, `windows_open_url`, `windows_play_youtube`, `windows_search`, `windows_displays`, `windows_wallpaper`, `windows_close_app`, `windows_lock`                               | Windows agent                                                                                                      |
| `browser`        | `browser_status`, `browser_search`, `browser_open`, `browser_read`, `browser_click`, `browser_click_confirmed`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_tab`               | Windows agent                                                                                                      |
| `termix`         | `termix_status`, `termix_hosts`, `termix_run_command`                                                                                                                                                          | `TERMIX_*`                                                                                                         |
| `pangolin`       | `pangolin_orgs`, `pangolin_sites`, `pangolin_resources`                                                                                                                                                        | `PANGOLIN_*`                                                                                                       |
| `omniroute`      | `omniroute_status`, `omniroute_agent_skills`                                                                                                                                                                   | `OMNIROUTE_ADMIN_PASSWORD`                                                                                         |
| `mcp`            | `mcp_<server>_<tool>` from your MCP servers (`deploy/mcp-servers.json`, or `mcp-servers.json` in the data folder)                                                                                              | the servers you configure                                                                                          |
| `skills`         | `skill_<id>` for each webhook skill you made in Settings                                                                                                                                                       | Settings screen                                                                                                    |
| `agent-skills`   | `skill_read`, `skill_list`, `skill_search`, `skill_install` for Agent Skills (SKILL.md) in `nova-data/agent-skills`                                                                                            | Settings > Advanced > Agent Skills                                                                                 |
| `visualization`  | `create_visualization`, `load_3d_scene`, `highlight_object`, `focus_camera`, ... (10 screen tools, see [Holographic visualization](architecture.md#holographic-visualization))                                 |

A tool whose integration is not configured stays in the list but is disabled; calling it answers "Unknown tool or integration unavailable". You can also switch tools or whole ability groups off in **Instellingen → Wat NOVA mag doen**, and `NOVA_EXTENSIONS=false` switches off every source except NOVA's own.

Before adding or enabling a tool, complete the [new-tool checklist](architecture.md#new-tool-checklist). It records the risk label, audit behavior, secret handling, network boundary and required regression evidence.

The default MCP list ships three servers installed in the image: `sequential-thinking` and `context7` (both `READ_ONLY`) and `filesystem` restricted to `/data/workspace` (labelled `CONFIRM`, which is only a label now). Servers whose `${VAR}` environment references are unset stay offline.

## Risk labels

Each tool still declares a risk (`READ_ONLY`, `SAFE`, `CONFIRM`, `DANGEROUS`). The label no longer gates anything: it is recorded in the audit log, shown in the tool list (**Instellingen → Wat NOVA mag doen**, `GET /api/tools`) and in the AI-activity view, and `READ_ONLY` marks the tools that background checks may use (objective checks, read-only autonomy steps and untrusted generated flows run with `readOnlyOnly`, which hides every other tool). Owner-initiated chat, voice and phone turns never run with `readOnlyOnly`. A source can refine the label per call (for example Home Assistant decides from the exact device and service in `home/risk.ts`). Every tool runs immediately, whatever its label.

Examples of how labels are decided: Proxmox power actions and Home Assistant locks, covers, scenes and scripts are labelled `CONFIRM` or `DANGEROUS`; Windows opening apps and URLs is `SAFE` and closing programs or locking is `CONFIRM`; MCP tools that declare `readOnlyHint` are `READ_ONLY`, otherwise the server's `risk` in the config applies (a server with a missing or invalid risk is not started); your own webhook skills declare `READ_ONLY`, `SAFE` or `CONFIRM`. In the Windows browser, `browser_click` also clicks buttons that buy, pay, order, donate, subscribe or delete (every click is sent as confirmed, so an older Windows agent does not refuse it either); `browser_click_confirmed` is the same tool, kept for older conversations. `browser_type` fills login, password and payment fields. NOVA never invents credentials.

### The action switch

`NOVA_ENABLE_ACTIONS` is a legacy flag and is ignored. All available tools, including model management through chat, execute directly. `NOVA_AUTO_EXECUTE_SAFE_ACTIONS` (default `true`) controls whether NOVA saves clear durable memories and learns from your corrections automatically; it does not gate tools either.

## Acting first, reporting afterwards

1. The model calls a tool. NOVA runs it at once; nothing asks, waits or expires. The call is logged with `confirmation: "auto_approved"`.
2. NOVA then tells you what it did, in the same answer. It reports what was actually checked: an accepted action is not described as verified unless the integration confirms it, and a failed or unverified call is never reported as done.
3. If the result is wrong or unwanted, say so ("nee", "dat klopt niet", "doe dat niet meer"). NOVA stores the correction and adjusts.

The helper pill and the Windows wallpaper behave the same way.

### Multi-step requests

For requests such as preparing a film night, NOVA can call several enabled tools in sequence and use each result to decide the next step. The chat shows a short, numbered activity hint and voice gives a brief explanation of the current work. This is a sequence of ordinary tool calls, not an atomic transaction. NOVA reports what was actually checked or accepted.

## What happens to every call

In order, for each tool call:

1. The tool must exist and be enabled.
2. **Argument cleaning (coercion)**: models fill optional fields with `""` or `null`, send numbers as text, and add fields that were never asked for. NOVA drops empty optional values, converts numeric and boolean text, rounds non-integers for integer fields, fixes the case of enum values, drops unknown fields (except numeric id-like ones such as `vmid`, which are kept so the meaning does not change) and removes the `reason` field that OmniRoute's Gemini adapter adds to empty schemas.
3. **Validation** against the tool's JSON schema (Ajv). Invalid arguments fail with `Invalid tool arguments`.
4. The source may **prepare** the call: decide the real risk label, resolve names, refuse ambiguous requests.
5. For anything that is not read-only, a log line `execution_started` is written **before** the action, so the call is not made if the log cannot be written.
6. **Execution** at once, with a timeout of at most 60 seconds (`NOVA_TOOL_TIMEOUT_MS`).
7. The result is sanitised, logged, remembered in the session context and a completion event is published on MQTT (`jarvis/events/tool`).

Tools may report `verified`: `true` when NOVA checked the effect (for example by reading the state back), `null` when it was done but could not be checked. A model may run at most eight tool calls from one reply; extra calls are dropped. The number of model rounds per message is limited by `NOVA_MAX_TOOL_ITERATIONS` (default 16, at most 32). The model sees at most 32 tools per turn (`MAX_MODEL_TOOLS`); `tool_search` finds the rest.

### Limits

These are size and budget caps, not approval steps. Nothing waits for the owner.

- **Background goals** (`agent_run`, `apps/api/src/agent/agent.types.ts`): goal 6 to 2,000 characters (also for direct delegation), 12 turns by default and at most 30, 10 minutes by default and at most 60, at most 4 goals at once, 500 turns per local day.
- **Autonomous tasks** (`autonomy_create`, `apps/api/src/planning/autonomy/autonomy.types.ts`): at most 20 steps per task, 8,000 characters of arguments per step, 50 active and 100 stored tasks, 5 runs and 4 steps at once. Every step runs directly whatever its risk; nothing waits for approval. A task saved by an older NOVA that still waited for approval is released on load.
- **Objectives**: a check may use any enabled `READ_ONLY` tool. A `service_online` target is up to 80 characters: letters, digits, spaces and common punctuation.
- **Home Assistant**: without an owner-set allowlist (mode `all`, or an allowlist with nothing selected) NOVA may use every entity. An unreadable access file falls back to all entities. A non-empty owner allowlist still limits NOVA to those areas, devices and entities.
- **Windows programs**: `windows_open_app` and `windows_close_app` accept any app-list name, program name, document or full path, up to 260 characters without control characters. Plain names are lower-cased (Windows resolves them case-insensitively); paths are passed as given.
- **Desktop takeover**: see [Session limits](windows-agent.md#session-limits) (30-1,800 s, 300 actions, 200 screenshots, 300 s idle, typed text up to 4,000 characters).
- **Termix**: `termix_run_command` accepts commands and multi-line scripts up to 8,000 characters.
- **Browser search**: on a robot check (Google's `/sorry/` page or a captcha text) the Windows agent switches from Google or Bing to DuckDuckGo's HTML page, and from DuckDuckGo to Bing. The model is told to switch engines instead of retrying.

The dashboard polls a few read-only tools (`proxmox_guests`, `proxmox_storage`, `timer_list`, `list_show`, `alerts_list`) quietly: no log entries and no conversation context.

## Audit log

`actions.jsonl` in the data folder holds one JSON object per line, append-only, file mode 0600: id, time, session, tool, arguments, risk label, a `confirmation` field (`auto_approved` for tool calls; other values such as `owner_correction` or `explicit_durable_request` mark entries NOVA writes itself), the result, verification and duration. When NOVA's database (`nova.db`) is available the same entries go to its `audit` table instead. Everything is sanitised before it is written. The newest entries are shown in the interface and at `GET /api/audit?limit=...` (at most 500, from the last 2 MB of the log).

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
- **Webhook skills and custom panels** (`safe-request.ts`): the same rules by default. The owner can tick "lokaal netwerk toestaan" (allow local network) per skill or panel to reach something on the LAN, with other ports; even then, this machine itself (`localhost`, loopback, `169.254.*` including cloud metadata, multicast, also when written as an IPv4-mapped IPv6 address such as `[::ffff:7f00:1]`) and NOVA's own internal services (`omniroute`, `qdrant`, `mqtt`, `node-red`, `stack-control`, `mcp-egress`, `piper`, `speaches`, `asterisk`, `linphone-chat`, their `nova-*` container names and `host.docker.internal`, with or without a trailing dot) stay forbidden. API integrations marked "local network" (`apis/safe-http.ts`) follow the same internal-host and mapped-address rules. Response size is capped (200 KB by default).
- **Agent Skills** (`skill_install`, `skill_search`): fixed hosts only (`api.github.com`, `raw.githubusercontent.com`, `skills.sh`) over the public-only `safe-request.ts` client, no private network, no redirects, no `git` or shell. See [Agent Skills](#agent-skills) below.
- **Windows agent**: NOVA sends only an app name or an `http(s)` URL; the allow-list lives on the PC.

## Free-model routing policy

Language-model requests only go out when the free route is verified. This fails closed. See [OmniRoute and free routing](integrations.md#language-models-omniroute).

## Access and exposure

- **NOVA has no access control of its own.** Anyone who can reach NOVA can chat with it, run its tools, read its memory and audit log and change its settings. The access control is the reverse proxy in front of it: let it terminate TLS and authenticate people, and keep NOVA off the open internet.
- **Other websites are refused.** No login does not mean any website may drive NOVA through your browser. Every state-changing `/api` request (anything but `GET`, `HEAD` and `OPTIONS`) from a browser must come from NOVA's own page: its `Origin` must equal the address the request was sent to, the `NOVA_PUBLIC_URL` host or a `NOVA_ALLOWED_HOSTS` name, and without an `Origin` the browser's `Sec-Fetch-Site` must be `same-origin` or `none`. A request body must be JSON (or carry `x-nova-admin: 1`); NOVA has no form parser, except for the token-checked Asterisk message route. Clients that are not browsers (Node-RED, the Linphone chat bridge, `curl`) send neither header and are not affected. Refusals answer `403` (or `415` for a non-JSON body) before any tool, agent, chat or settings code runs (`core/security/request-origin.ts`).
- **Rebound host names are refused.** Every `/api` request, reads included, must name NOVA by an IP address, a local name (no dot, `localhost`, `*.local`, `*.lan`, `*.internal`, `*.home.arpa`), this machine's hostname, the `NOVA_PUBLIC_URL` host or a `NOVA_ALLOWED_HOSTS` entry. A public name that an attacker's DNS points at your LAN therefore gets `403`. If you reach NOVA through another name (a second proxy domain, a Tailscale name), add it to `NOVA_ALLOWED_HOSTS`.
- **Proxy setup.** The proxy must preserve the external `Host`, overwrite forwarded headers, pass server-sent events without buffering and proxy only to the NOVA API. Firewall host ports `8080` and `8443` so nothing can bypass the proxy. The app does not trust client-supplied `X-Forwarded-*` headers.
- **Tokens that remain.** The Windows pairing token (`WINDOWS_AGENT_TOKEN`) pairs a PC with NOVA. `NODE_RED_EVENT_TOKEN` and `NODE_RED_FLOW_TOKEN` wire Node-RED and NOVA together, and `NOVA_STACK_CONTROL_TOKEN` wires NOVA to the private stack-control broker. They are infrastructure, not user logins.
- **Other containers.** The compose file publishes OmniRoute's dashboard (20128) and MQTT (1883) on the host and runs them as root; Home Assistant uses host networking (8123). Restrict them with your firewall. Node-RED (1880) and Qdrant are reachable only on the internal Compose network. The compose file ships no Mosquitto configuration, so authentication on MQTT is up to you.
- **Strangers on the phone line are not the owner.** A Linphone/SIP text message is matched on the address inside `<...>` only, never on the display name or header parameters. Contacts marked "Mag met NOVA praten" get read-only tools; only the owner's own addresses in `NOVA_OWNER_SIP` get the full toolset. Text from contacts, phone callers, agents, autonomy, objectives, proactive prompts and the autopilot never writes durable memory ("Onthoud ..."), never teaches a correction or alias, never mutes an autopilot alert and is left out of the nightly preference learner (`chat/session-provenance.ts`).
- **Stored credentials stay with their address.** Testing or saving a connection (Home Assistant, Termix, Windows, Proxmox, Node-RED, Qdrant, Pangolin, MQTT) with a different address drops the stored secrets: enter them again for the new address. A webhook skill keeps a stored secret header only while its URL and method are unchanged.
- **What stays in place.** The audit log, secret masking and the encrypted API vault, the memory filter that refuses secrets and card numbers, the net guard for outbound URLs, fail-closed free-model routing and, on a paired Windows PC, the emergency stop **Ctrl+Alt+Shift+K**.

## Chat file attachments

Use the paperclip beside the chat input for PDF, Word (.docx), PNG/JPEG/WebP/GIF images, text, source code, CSV, JSON, Markdown and logs. Attach up to five files, at most 10 MiB each and 20 MiB in total. Click a selected file to remove it. Files can accompany a question or be sent on their own. A failed request keeps the draft and files so you can retry.

PDF and DOCX body text are extracted locally in an isolated, time-limited worker. Images are sent as vision input through the existing OmniRoute free route; the chosen model must support images. NOVA does not switch to a paid provider to read them. Legacy .doc, Excel/PowerPoint files, archives and audio/video are unsupported; export documents as PDF and spreadsheets as CSV.

NOVA sees at most the first 24,000 characters of each text document and at most 100 PDF pages. If a file is excerpted, chat displays a notice and the model is told it has an excerpt. Scanned PDFs without text need an image of the relevant page; there is no OCR step. Document layouts, drawings and embedded DOCX images are not preserved.

Files are held in memory during the request, never saved to the server filesystem or as file contents in conversation history. The browser history shows file names. To ask another question about a file in a later turn, attach it again.

## Clipboard help

Click the clipboard button next to chat input to read copied text. Browser clipboard permission may be requested. NOVA shows the complete prepared text and asks you to choose **Vat samen** or **Vertaal** before sending anything. **Annuleren** clears the preview. Each new use requires another button click and task choice; there is no background clipboard watcher.

The browser masks recognizable credentials, including password fields, API keys, bearer tokens and JWTs, before the preview and request. Review the preview: masking cannot recognize every private detail. Only the prepared text is sent as a temporary text attachment through the normal chat route, up to 12,000 characters. The attachment body is not saved in conversation history or local storage; chat keeps the task and the resulting answer as usual. Clearing the panel or sending the request discards the browser copy held by this feature. The selected conversation language determines the translation target. Clipboard help needs a secure browser context and clipboard access.

## Screen help

Click the screen button beside chat input, then choose a screen or window in the browser's sharing prompt. NOVA captures one frame, stops every capture track immediately, and shows the frame for review. Add an optional question and click **Vraag NOVA** to send it; **Annuleren** discards the frame. There is no background capture or continuous stream to NOVA.

The browser bounds the image to 1,600 pixels on its longest side. The chosen frame travels as a temporary image attachment through the existing chat route. The server requires a model configured for the `vision` role and today's verified-free model set; otherwise it blocks inference. The image body is not saved to conversation history or browser storage, but your question and NOVA's answer follow normal chat history. Hide sensitive information before capture: image text cannot be reliably redacted automatically. Browser screen sharing needs a secure context and browser support.

## Conversation style

NOVA aims to be a calm, attentive personal assistant: understand the intention, act within the request, and explain the useful result. It can acknowledge a difficult day without launching unrelated tools, and suggest a relevant next step without appending an offer to every answer. Claims of success still follow the backend's verification: NOVA does not say something happened unless a tool confirms it.

Typed chat allows useful lists, links, code and fuller explanations. Speech recognition and the wake word identify voice turns, which favour natural spoken sentences. Tool results preserve that turn's style rather than forcing every answer into four sentences. The model receives the last six conversation turns (twelve messages) for continuity, plus relevant older memory. The user's own persona settings remain in effect.

## Personal settings through chat

NOVA can replace personal conversation rules, create an instruction skill, enable or disable an existing instruction skill and set helper preferences through dedicated settings tools. Changes apply at once, use the same validation and storage as the settings page and are audited. Changing the persona or skill configuration is simply the new state: there is no pending step.

The read-only skill list exposes identifiers, names, types, enabled state and versions, without credentials or HTTP bindings. Chat cannot create or enable webhook bindings, edit service credentials or add executable code through these settings tools. Manage those bindings on the settings page. Instruction skills describe a workflow using existing tools.

## Native gateway skill modes

The Models settings page can change the mode of an existing NOVA-owned native OmniRoute skill. Native skills may execute handler code inside the gateway. The change is written directly and then checked: NOVA reads the actual mode, enabled state and execution binding back through the read-only database, and refuses overlapping changes to the same skill. Shared/global and other-owner skills cannot be changed through this endpoint. There is no chat tool for it. The upstream runtime cache may take a minute to reflect a saved change. External gateway administrators are not covered by NOVA's local in-flight guard.

## Agent Skills

NOVA reads skills in the open [Agent Skills format](https://agentskills.io/specification) (a folder with a `SKILL.md`, as used by Claude, `npx skills` and skills.sh). They are **text only**: `SKILL.md` and bundled Markdown/text reference files. Scripts, binaries and other files in a skill are never stored and never run; `allowed-tools` in the frontmatter is ignored and grants nothing.

- **Progressive disclosure.** Only the `name` and `description` of enabled skills go into the system prompt, as one `SKILLS` message capped at 2,400 characters (about 600 tokens; descriptions are cut at 300 characters, overflow is replaced by a pointer to `skill_list`). `skill_read` (read-only, always offered while a skill is enabled) returns the body or one listed reference file.
- **Untrusted, but usable guidance.** The tool result is marked untrusted. The tool description tells the model it may follow a skill's guidance for the owner's current task, but a skill never overrides the user, NOVA's rules or confirmations, and never authorizes extra actions or sharing data.
- **Storage.** `NOVA_DATA_DIR/agent-skills/<name>/` (`0700` folders, `0600` files), plus `.nova-state.json` with on/off state and the source. Symlinked folders and files are ignored; file paths are at most four segments of `[A-Za-z0-9._-]` without hidden or `..` parts; `SKILL.md` and each reference file are at most 64 KiB, at most 24 reference files and 512 KiB per skill, at most 100 skills. Installs write to a temporary folder and swap it in with a rename.
- **Validation.** The frontmatter must have a valid `name` (1-64 lowercase letters, digits and single hyphens, equal to the folder name) and `description` (1-1024 characters); `license`, `compatibility` (at most 500), `metadata` (string map) and `allowed-tools` are read, other keys are ignored. Invalid skills are listed with the reason and never offered.
- **Self-install.** `skill_install` is `SAFE`: NOVA may install or update a skill without asking when it helps the task and reports it afterwards. A skill with the same name from another source is only replaced with `replace`. Removing a skill is only possible in the settings.

## Speech transport

The speech API accepts plain text. Known credentials and credential patterns are redacted before synthesis and caching; text is XML-escaped before the Edge SDK puts it in SSML. Piper continues to receive plain text. Edge connections have a five-second connection deadline and a fifteen-second synthesis idle deadline; the client closes even when initialization fails.

The browser retries one HTTP500/502/503/504 speech failure with the same request. It does not retry cancellation, authorization errors, rate-limit responses or a `Retry-After` instruction. If synthesis still fails, further queued speech is stopped, the complete text response remains available and one short notice appears in the main app or helper conversation. Failed synthesis does not report a playback latency or start microphone follow-up. The helper does not open fullscreen for the notice.
