# Features

What you can do with NOVA, grouped by area. NOVA runs unrestricted: every feature acts at once and is only audit-logged, see [Tools and safety](tools-and-safety.md). Screen labels are Dutch because the interface is Dutch; they are quoted as they appear.

Contents: [Voice and conversation](#voice-and-conversation) · [Memory and notes](#memory-notes-and-documents) · [Planning](#timers-lists-and-cooking) · [Proactive behavior](#proactive-behavior) · [Personalization](#personalization-and-extensions) · [Research and images](#research-and-images) · [Autopilot](#autopilot-nova-takes-initiative) · [Standing objectives](#standing-objectives)

## Voice and conversation

- **Wake word, push to talk, typing.** Say "Hey NOVA", hold **F8**, tap the sphere, or type. Speech recognition is the browser's, so the microphone needs HTTPS or `localhost`. Spoken answers use Microsoft neural voices by default (`nl-NL-FennaNeural`, selectable, with pace, pitch and custom pronunciations). A local Piper voice is optional, see [Integrations](integrations.md#optional-local-piper-voice).
- **Conversation language.** Choose Nederlands or English in the chat composer. The choice is stored in this browser for the current conversation and applies to model answers, tool progress and the spoken reply; recognition listens in the same language. If the configured voice does not match, Dutch uses Fenna and English uses Ryan. It is sent with chat requests as a two-value enum.
- **Real conversations.** Hands-free browser sessions and phone calls (extension 700 via Asterisk and Linphone) are described in [Telephony and conversations](integrations.md#telephony-and-conversations). Both are off by default.
- **Conversation handoff.** **Gesprek → Overdracht** saves the last question, up to eight relevant file names and a next step as a card in this browser's local storage for at most 30 days. Nothing is sent to NOVA or OmniRoute. After a reload **Verder hiermee** sends it as a new question (NOVA first re-checks the current state) and **Wissen** deletes it. Do not put passwords or tokens in it.

## Memory, notes and documents

**Short-term context** is the running conversation (`memory.json`). **Long-term memory** holds durable facts in Qdrant (with free embeddings) or in OmniRoute's native memory, separate from the transcript. Inspect, correct or delete it in **Instellingen → Geheugen**.

- NOVA stores a memory only when you ask ("Onthoud dat ...", "Remember that ..."); it never infers relationship facts, and rejects secrets, credentials, card numbers and short-lived state. "Wat weet je over mij?" answers only from returned records. "Vergeet dit" must resolve to one record and deletes it at once. Deleting a memory does not erase the original transcript.
- The audit log records only that a memory was stored, its category and a redacted marker.
- At 02:45 in NOVA's time zone it can summarize the previous day into one `CONVERSATION_SUMMARY` record using only the verified-free `summary` model role; if that route is unavailable it does not fall back to the chat model. A private `0600` file stores only the last completed date.
- Retrieved memory is context, never instructions.

### Memory lifecycle (Qdrant backend)

Code: `apps/api/src/memory/semantic/lifecycle.ts` (rules), `qdrant.backend.ts` (store), `memory.source.ts` (tools). Old records stay readable; missing fields are derived on read.

| Field                                                          | Values                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `kind`                                                         | `fact`, `preference`, `decision`, `assumption`, `episode`, `project`  |
| `origin`                                                       | `user_stated`, `inferred`, `tool`                                     |
| `confidence`                                                   | 0..1; `inferred` is capped at 0.4                                     |
| `created_at`, `updated_at`, `last_accessed_at`, `access_count` | usage tracking                                                        |
| `superseded_by`, `valid_until`                                 | set when a newer record replaced this one, or on an expiry date       |
| `sensitive`                                                    | true for IBAN/BSN/health words; never for secrets, which are rejected |

- **Writing (`memory_remember`).** Secrets and card numbers are rejected, as are inferred memories containing sensitive data. A near-duplicate (same normalized text, or similarity >= 0.97 with the same entity and no contradiction) updates the existing record. Contradiction uses a deterministic subject/value check on a few Dutch sentence shapes (`mijn X is Y`, `ik woon in Y`, `ik ben N jaar`, ...); the embedding only finds candidates. A new user-stated value supersedes the old record, which is kept with `superseded_by` and `valid_until`. An inferred memory is stored as a low-confidence `assumption`, never overrides a user-stated record, and is superseded by a later user statement.
- **Retrieval.** score = similarity x recency decay (half-life by kind, episode 30 days to fact 4 years) x (0.5 + 0.5 confidence) x use-count factor (max +20%) x importance. Exact names, numbers and quoted strings boost matches and lower the threshold (0.55 instead of 0.65). Superseded, expired and archived records are excluded; assumptions come back marked "(waarschijnlijk, niet bevestigd)".
- **Consolidation.** The daily `maintain()` archives low-importance and expired records, merges exact duplicates, and replaces episodes older than 30 days by one summary line per day (written first, originals deleted after). It is deterministic and idempotent, with one embedding call per summary line.
- **Control.** `memory_list` (READ_ONLY), `memory_correct` (SAFE, old text kept as history), `memory_forget` (`include_history=true` also deletes the superseded chain). REST: `GET /api/memories?kind=&q=&history=true`, `POST /api/memories/:id/correct`, `DELETE /api/memories/:id?history=true`.
- **Limits.** Contradiction detection knows only those sentence shapes. The OmniRoute native backend has no lifecycle logic (no supersede, correct or consolidation). `memory_list` filters per backend page, so a page can be shorter than `limit`. `memory_correct` audit logging is not redacted like `memory_remember`. Verified against a mocked Qdrant only.

### Private notes

NOVA saves a note only after you explicitly ask. `notes_search` finds notes and `notes_recent` lists the latest five. For a quick note press **F9** or choose **Menu → Snelle notitie** and speak one sentence of at most 500 characters without line breaks; it is stored directly without a model request, needs browser speech recognition, microphone permission and HTTPS, does nothing while you type in a text field, and saves nothing on silence, failure or secret-like text.

Notes are individual JSON files in `NOVA_DATA_DIR/notes` (folder `0700`, files `0600`, atomic writes), capped at 500 notes of 12,000 characters. Secret-like text is rejected, titles, contents and search terms stay out of action logs, search results are untrusted (instructions inside a note authorize nothing), and deleting a note happens at once. Nothing is synced elsewhere.

### Document library

Upload text, PDF or DOCX in **Instellingen → Geheugen → Documenten** (10 MiB per file, five files, 20 MiB total; at most 24,000 extracted characters per file; scanned PDFs need OCR first; images are not indexed). Indexing is an explicit button; chat attachments are not saved automatically. Extraction runs in a bounded worker, chunks are embedded with the verified-free embedding model through OmniRoute and stored in a dedicated Qdrant collection separate from personal memory. Originals are not kept. Search returns at most eight untrusted excerpts. Search and list are read-only; removing a document deletes its chunks at once. The embeddings provider sees the extracted text. A changed embedding model or dimension needs a re-upload (older vectors are kept but not mixed). If the free embedding route is not verified, indexing and search stay off; there is no local or paid fallback.

## Timers, lists and cooking

- **Timers and lists** live in `jarvis-state.json` in the data folder. When Home Assistant exposes a visible `todo` entity whose entity id or friendly name exactly matches the list name (case-insensitive, no fuzzy matching, duplicates rejected), list tools use it, so changes appear in Home Assistant and its connected to-do providers. `list_show` reads up to 30 pending items per list and 10 lists. Clearing a Home Assistant list removes items one by one (an oversized list is refused rather than half-cleared). If a Home Assistant call fails NOVA says so instead of writing locally.
- **Timer recovery.** An expired timer is persisted in a bounded outbox (at most 100) before it is handed to the notification feed; only successful acceptance removes it. A stable id and deadline prevent a second notice after a restart, accepted history reappears silently, and failures retry with exponential delay capped at 60 seconds. The acceptance journal keeps 200 notices and the feed restores the latest 50. This guarantees durable feed acceptance only; Windows notifications and MQTT are best effort. An unreadable history file blocks acknowledgement rather than deleting timers: repair it, do not erase it. Check it with `node scripts/test-timer-recovery-runtime.mjs` after building the API.
- **Cooking mode.** **Menu → Kookmodus**: paste a recipe with one step per line (at most 30 steps, 400 characters per step, 12,000 in total) and start. NOVA reads the current step; buttons **Vorige**, **Herhaal**, **Volgende stap** work without a microphone, and the exact phrases "volgende stap", "herhaal", "vorige stap" and "stop kookmodus" are handled locally. A step timer (1-240 minutes) is created only when you press **Start timer**, appears in the normal planner as "Kookstap N" and survives closing cooking mode. The recipe stays in the browser for this page visit and is never sent to a model.

## Proactive behavior

Alerts always stay in the feed. Delivery to the helper or voice is separate and bounded:

- **Delivery modes.** In the helper settings choose per category (info, briefings, warnings, critical, timers): screen only, helper notice with a short sound, or spoken. Defaults: info to the helper, the rest spoken. At most five spoken announcements per rolling hour; later items stay visible and are marked silent. Quiet hours apply in the helper and the browser, and nothing interrupts an active conversation or audio. A missed announcement is never replayed aloud.
- **Presence.** Speech is suppressed only when exactly one visible Home Assistant `person` is `not_home` and the Windows helper is closed (an open helper permits speech). Multiple people are ambiguous and NOVA chooses none; unknown or stale presence keeps normal delivery. Refreshed every 30 seconds; no name or location enters the feed or audit log. On a confirmed `home` to `away` transition NOVA checks the next three forecast hours and adds a hint at 65% rain probability or for thunder, hail, ice or heavy precipitation.
- **Rituals (all off by default).** Under the helper's **Meldingen → Rituelen**: morning greeting, bedtime greeting, a silence check-in (after 3, 4 or 6 hours of no chat, only 10:00-20:00, once a day), calendar reminders (5, 15 or 30 minutes ahead, see [Integrations](integrations.md#calendar-caldav)), the Sunday weekly overview (default 18:00), a daily highlight, and small surprises. Rituals are ordinary info alerts, so every gate above applies, and a private `0600` progress file stores only the local day and which ran.
- **Weekly overview.** Summarizes the previous Monday-Sunday and up to two upcoming calendar items from recent conversation text, tool names and counts, and calendar titles (no arguments or results). It uses only the verified-free `summary` role and never falls back to the chat model; up to three attempts.
- **Daily highlight.** At a chosen local time NOVA sends one fixed, non-identifying positive sentence, but only when it can prove one: an explicit positive statement from that day's conversation, or (from at most 500 recent action-log lines) a verified successful `code_run_tests`, `code_self_test` or `node_red_flow_create`. Pending, refused or failed actions, invalid dates and anything outside the local day do not count. No model call; a transient read error leaves the day open to retry; a durable receipt prevents a repeat after a restart.
- **Small surprises.** **Kleine verrassingen bij een gelegenheid** (helper settings) uses fixed short sentences for a birthday, New Year and the 100th completed chat turn, with no model call, only between 09:00 and 20:00, outside focus, quiet hours and known absence, and within the shared daily cap. The birthday from the settings wins; if empty, an explicitly stored own birthday from memory is used ("Onthoud: ik ben jarig op 15 oktober", a written-out month or ISO date; ambiguous digit dates are not guessed, conflicting valid dates give no wish; at most five pages of 100 memories are read). `conversation-milestone.json` holds only a version, a counter up to 100 and a delivered flag. A turn counts when `/api/chat` or `/api/chat-stream` completes a full answer (including plain Node-RED ask calls), not failed, interrupted or `unavailable: true` answers or the proactive route.
- **Repeated requests.** If the same non-secret request appears on three separate local days within a week in the same hour, NOVA may offer once to automate it. It creates nothing without your explicit request.
- **Scheduled Node-RED briefings** use the read-only proactive route, see [Node-RED](integrations.md#the-nova-nodes). Proactive routines can read data and publish a bounded notification; they cannot create or run a device action.
- **Phone push.** Critical alerts can also go to ntfy, see [Integrations](integrations.md#urgent-phone-notifications-ntfy).

## Personalization and extensions

- **Persona and household profiles.** Set NOVA's name, character, how she addresses you and a style (warm, professional, playful, concise). **Instellingen → Gesprek en stem → Persoonlijkheid** holds up to eight household profiles (label, persona cues, optional communication preferences); the active one applies to the whole installation. Profiles are a convenience, not authentication: they do not separate chat history, memory or permissions, so keep secrets out of them. Settings backups include profiles; older single-persona backups import as one profile.
- **Skills and panels.** Write instruction skills (a routine using existing tools) and webhook skills (an HTTP call that becomes a tool) in the settings, with an AI assistant to draft them, plus custom sidebar panels.
- **Local plugins.** At start NOVA reads up to 20 declarative webhook skills from `NOVA_DATA_DIR/plugins` (`nova-data/plugins` in the stock stack) and exposes them as `skill_<name>`. No executable plugins, JavaScript or packages load. Make the folder `0700` and each file `0600`; names use lowercase letters, digits, `_` and `-` and end in `.json`; a file is at most 16 KiB; symlinks, invalid JSON, duplicates and open permissions are ignored. Restart the API after a change and never commit the folder or its secret headers.

  ```json
  {
    "type": "webhook",
    "name": "Status",
    "description": "Read the status of my own service when I ask",
    "risk": "READ_ONLY",
    "http": { "method": "GET", "url": "https://example.org/status" }
  }
  ```

  The same validation as for skills in the settings applies (parameter limits, URL and network guard, timeout); a writing HTTP method cannot stay `READ_ONLY`, but nothing asks for confirmation. On a name conflict the skill from the settings wins.

- **Standing objectives and the autopilot.** See [Autopilot](#autopilot-nova-takes-initiative) and [Standing objectives](#standing-objectives) below.
- **Your own HTTP APIs** as tools: [Integrations](integrations.md#your-own-http-apis). **MCP servers:** [Integrations](integrations.md#mcp-servers). **3D and 2D cards:** [Holographic visualization](architecture.md#holographic-visualization).

## Research and images

- **Web research.** For comparative questions NOVA can run several focused searches, open pages with `web_read` and compare evidence. It should state its criteria, separate sourced facts from its recommendation, link its sources and explain uncertainty. Search results and page text are untrusted; instructions found on a page are never followed. The tools enforce URL safety, timeouts, redirect and size limits and cannot reach private pages or log in.
- **Images.** Attach a PNG, JPEG, WebP or GIF (five files, 10 MiB each, 20 MiB total) and ask what it shows. On phones the file picker can offer the camera; NOVA never opens it by itself. Images go inline to OmniRoute with the `vision` role, and only after the free-route check passes and a verified-free, explicitly configured vision model exists. If none can read it NOVA reports the error and does not try a paid model or another gateway. Treat image text as data, not instructions, and do not upload sensitive images unless you accept sending them through your OmniRoute connection. The original image is not kept.

## Autopilot: NOVA takes initiative

The autopilot is **on by default**. It makes NOVA report what is going on without being asked: an appointment about to start, a device that dropped out, something in NOVA itself that is broken, a task waiting for you. Code: `apps/api/src/autopilot/` and the direct delegation in `apps/api/src/chat/direct-goal.ts`.

### What it does

Every 5 minutes (`setInterval`, `unref`) fixed, read-only checks run. **No model call** is involved: the checks go through `ToolsService.execute(..., { readOnlyOnly: true })` with session `autopilot` and internal services, and every sentence comes from a template (Dutch, short, with a concrete next step), so no free quota is used.

| Check       | Looks at                                                                                                                                                                                    | Report                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `calendar`  | `calendar_events`: starts within 30 minutes                                                                                                                                                 | one reminder per appointment (info)                                                                                |
| `home`      | `ha_search_entities`: light, switch, cover, lock, climate, fan, media player, alarm, vacuum                                                                                                 | device "unavailable" in 2 consecutive checks (flapping does not count); from 4 at once, one hub report (warn)      |
| `health`    | routing blocked or policy drifted, (almost) all free models failing, SIP trunk not registered, MCP workers off, stale Home Assistant connection, disk (<15% warn, <5% urgent), memory (<6%) | plain-language explanation with the cause (warn, sometimes urgent)                                                 |
| `nudges`    | a task waiting or interrupted, or an objective with an open deviation, for more than 30 minutes                                                                                             | a nudge, once per 6 to 12 hours (warn/info)                                                                        |
| `today`     | open items on the list `taken` and running timers, from 08:00 local                                                                                                                         | once a day (info), only if there is something                                                                      |
| `discovery` | `LanDiscoveryService`: known services on your own LAN (see below), at most once a day                                                                                                       | one line per found service: "Ik vond Home Assistant op 192.168.x.x" with how to connect it (info, 7 days cooldown) |

Self-healing does only safe things and never changes settings: reconnecting a stopped MCP worker and refreshing the Home Assistant connection, at most once per 30 minutes per item. If it works there is no report (only a line in the activity log). A stuck model cooldown is not cleared; it lives in the chat client, outside this module.

Every finding has an `id`, an urgency (`info`/`warn`/`urgent`), a dedupe key and its own cooldown; the same key is not reported again within the cooldown (appointment 24 h, device 12 h, routing and trunk 6 h).

### How it reaches you

1. **Alert feed** (`JarvisStateStore`, topic `jarvis/alerts`): the interface shows and speaks it when it is open.
2. **Linphone text** to saved contacts with "Mag met NOVA praten" (`allowConversation`), via `TelephonyService.sendText(name, text)`: ARI `POST /endpoints/sendMessage` with `to=pjsip:trunk/sip:<user>@<domain>` and `from=sip:<trunkuser>@<trunkhost>`. Only when telephony is on, the trunk is set, Asterisk is reachable and the trunk is not reported offline. For every urgency by default (`textMinUrgency`).
3. **Phone call:** **on** by default (`allowCalls: true`, switch it off with `PUT /api/settings/autopilot`). Only an urgent finding, outside quiet hours, with telephony working, through the normal `phone_call` tool to the first contact with `allowConversation`. The call is placed without asking first.

### Limits (defaults, all adjustable)

- Quiet hours 23:00-07:00 Europe/Amsterdam: only `urgent` gets through (feed and text, never a call). Whatever is held back in quiet hours is reported at the first check afterwards if it still applies.
- Daily budget of 10 initiatives and at most 3 per hour (all channels together count as one initiative); `urgent` may use up to double of both. Per finding a cooldown (above), check interval 5 minutes, daily limit by local day.

### Default objectives (once)

At the first check, if no objective exists yet (flag `bootstrapped` in `autopilot.json`): with Proxmox a `servers_gezond` objective (which includes the service check), otherwise a `service_online` objective per running core service (omniroute, mqtt, qdrant, speech, Home Assistant; at most three) via `ObjectivesService.create`. What the installation does not have is skipped silently. If you delete such an objective it does not come back.

### Direct delegation without a model

`directGoalQuery()` recognizes explicit commands of at least four words that are not ordinary questions: "regel ...", "zoek ... uit", "onderzoek ...", "werk ... af", "plan en voer ... uit", "handel ... af", "sort this out", "figure out ...", also polite ("kun je dit voor me regelen"). Then `AgentService.start(goal)` starts at once and NOVA answers "Ik ga ermee aan de slag en meld me zodra het klaar is." "houd ... in de gaten", "laat me weten als ...", "zorg dat ... blijft" create an objective when a clear template fits (`servers_gezond`, `agenda_leeg`, `ha_waarde` with an entity); otherwise the model decides. Questions ("wat is het regelen van een lening", "hoe regel ik ...?") always go to the model. Sessions `agent_*` and read-only text chats (Linphone) never delegate. The hook in `OrchestratorService` is `setGoalDelegator`; the autopilot registers itself there.

### Seeing what it does

- `GET /api/autopilot/status`: last check, findings (with outcome `gemeld`, `cooldown`, `stil`, `budget`, `limiet`), initiatives today and this hour, next check, on/off, last 30 activities.
- `GET /api/autopilot/activity`: the full activity log (at most 200), metadata only (kind, check, urgency, outcome), never text, titles or names. `lastFindings` in `autopilot.json` does keep the title of the latest findings (for example an appointment name); the file is `0600`.
- `POST /api/autopilot/scan`: run one round now (same rules). Tool `autopilot_status` answers "what did you do yourself?".

### Settings and switching it off

Everything is in `autopilot.json` in the data folder (`0600`, atomic writes, a restart continues where it was) and through `GET`/`PUT /api/settings/autopilot`. Fields: `enabled`, `intervalMinutes`, `quiet` (`enabled`, `start`, `end`, `timezone`), `dailyBudget`, `hourlyLimit`, `textContacts`, `textMinUrgency`, `allowCalls`, `scans` (per check on/off), `calendarLeadMinutes`, `staleMinutes`, `selfHeal`.

**Kill switch:** `PUT /api/settings/autopilot` with `{"enabled": false}`, or tell NOVA "zet de autopilot uit" (tool `autopilot_set`), or `"enabled": false` in `autopilot.json` and restart. Only text messages off: `{"textContacts": false}`. One check off: `{"scans": {"home": false}}`. If you also switch on the dashboard's own calendar reminders (**Helper → Meldingen → Rituelen**) appointments are reported twice; turn one of the two off.

### Learning and self-tuning

NOVA is not held back by locks, so the way to steer it is to tell it. Tell it something is wrong ("nee, ...", "dat klopt niet", "doe dat niet meer") and it learns from it; nudges you brush off make the autopilot quieter by itself. Learning stores memories and aliases and tunes the autopilot's own rhythm.

- **Corrections are learned.** `apps/api/src/chat/correction.ts` recognises correction turns in Dutch and English ("nee, ...", "dat klopt niet", "fout", "dat bedoelde ik niet", "that's wrong", "doe dat niet meer"). `CorrectionLearner` stores the corrected fact, preference or rule as an **inferred** memory (confidence ceiling 0.4, tags `learned` and `owner-correction`, audit entry `memory_learned`) and supersedes a contradicting memory through the same mechanics as `memory_correct` (old text stays as history). "de grote lamp is light.woonkamer" (or "met de grote lamp bedoel ik light.woonkamer") becomes a `LEARNED_ALIAS` that the Home Assistant name lookup already reads. Secrets, card numbers and other sensitive text are never stored, and nothing is learned from turns with attachments or read-only generated flows. The chat prompt now also lets NOVA save clear durable preferences and facts the owner states (as inferred, unconfirmed memories) without "Onthoud".
- **LAN discovery (read-only).** `lan_discover` (READ_ONLY) and the `discovery` check probe only RFC 1918 addresses (`isLanAddress` in `core/security/net-guard.ts`, re-checked per touch): the own /24, an mDNS and an SSDP question, a TCP connect to well-known ports and one landing-page GET to recognise Home Assistant, Proxmox, Node-RED, MQTT, OmniRoute, Qdrant and Grafana. Budget: 30 s, 3000 requests, 32 at a time; manual rescans at most every 10 minutes, the autopilot once a day. Results live in `lan-discovery.json`. Nothing is connected automatically: a service without login can be linked through the normal `api_connect` (SAFE) flow; anything with a login asks for your own key, credentials are never invented.
- **Self-tuning.** Each nudge awaits a reaction. `POST /api/autopilot/reaction` (`dismissed`, `acted`, `stopped`) and a nudge left alone for 24 hours (`ignored`) feed `autopilot.tuning.ts`: a kind of nudge that is brushed off 3 times in 4 comes back at half the rate (cooldown factor up to 8x), 4 rebuffs in 48 hours lower the daily budget by one (minimum 2), 6 ignored nudges stretch the check interval (maximum 30 minutes), and rebuffs clustered within two hours before or after the quiet hours widen them by 30 minutes (at most 2 hours). Acting on nudges again moves everything back up. Tuning is only ever quieter than what you set: your last manual setting is the ceiling it recovers to. "Doe dat niet meer" within 6 hours of a nudge mutes that nudge for 30 days. Every self-change is an activity entry of kind `tuning` ("zelf aangepast: ..."); `status().tuning` shows the cooldown factors and muted nudges.

### Not verified

- LAN discovery (mDNS/SSDP, real port probes) was tested with a fake transport only, not on a real network; nothing in the app calls `/api/autopilot/reaction` yet, so today only ignored nudges and 'doe dat niet meer' feed self-tuning.
- No **live test** of a Linphone message was done. `sendText` is tested against a fake ARI (right `to`, `from`, `body`); whether Asterisk really delivers the SIP MESSAGE through the trunk and Linphone shows it is not proven.
- "Trunk registered" reads the PJSIP endpoint `trunk` through ARI: only `offline` counts as not registered, `unknown` counts as ready. Whether Asterisk keeps that status reliably at your provider is unchecked.
- "Almost all models failing" uses OmniRoute's statistics of the last 24 hours (only if the admin connection is set), so it lags behind an outage of today.
- The call for an urgent finding was tested with fake services only, not a real phone. Memory comes from the host or container `/proc/meminfo`, not a cgroup limit. Nothing was tried against a running production install.

## Standing objectives

NOVA can watch a lasting goal without being asked again: "zorg dat mijn servers gezond blijven", "houd de garagedeur in de gaten", "laat het me weten als de dienst uitvalt". Code: `apps/api/src/objectives/`.

### What it does

- An objective consists of checks. Each check is a read-only tool (only `READ_ONLY` and only this list: `proxmox_status`, `proxmox_guests`, `network_check`, `ha_get_state`, `calendar_events`), fixed arguments, and a fixed condition describing what is wrong (for example `nodes[].cpu.usagePercent > 90`).
- A light scheduler (`setInterval`, `unref`) runs the objectives that are due. The next time follows from the stored `lastCheckAt`, so after a restart it continues without a flood of catch-up checks; an objective that stood still for long runs once.
- Checks go through `ToolsService.execute(..., { readOnlyOnly: true })` with session `objective_<id>`. Conditions are evaluated in code: routine checks use no model and cost no free quota.
- Dedupe: a deviation counts only after N consecutive checks (debounce, per check). Exactly one report goes out when a deviation starts (or changes composition) and a "Hersteld" when it disappears. A tool failing three times in a row counts as a deviation itself ("de controle zelf mislukt").
- Only for a new or changed deviation with urgency `warn` or `urgent`, `AgentService.start()` starts an investigation ("onderzoek waarom ..."), at most once per 30 minutes per objective, with 5 turns and 8 minutes. The final summary is stored on the objective (`lastInvestigation`) and posted as a follow-up in the alert feed.

### Templates

The model picks a template and fills in parameters; it never supplies tools or conditions itself. Unknown templates are refused.

| Template         | Checks                                                                                         | Parameters                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `servers_gezond` | node offline (urgent, 2x), CPU (3x), memory (3x), stopped guests (info, 2x), service down (2x) | `cpuMax` 90, `memMax` 90, `maxStopped` 0       |
| `service_online` | a `network_check` target (name from `NOVA_CHECK_TARGETS` or the NOVA stack) answers            | `target`, `consecutive` 2                      |
| `ha_waarde`      | Home Assistant entity compared with a value (`cover.garage == open`)                           | `entity`, `operator`, `value`, `consecutive` 1 |
| `agenda_leeg`    | no appointments in the next seven days (`calendar_events` empty)                               | none                                           |

`kind: "monitor"` keeps watching; `kind: "followup"` reports once and then ends (`fulfilledAt`).

### Reports and silence

- Urgency: `info`, `warn`, `urgent` (feed severity info, warning, critical). Quiet hours default 23:00-07:00 Europe/Amsterdam: checks run and are recorded, but only `urgent` reports; an unreported deviation that still exists after quiet hours is then reported.
- Per objective a wait between reports (default 30 minutes; `urgent` ignores it). A global daily budget of 8 reports (local day); `urgent` may use up to double. "Hersteld" and investigation reports count but ignore the wait. The budget value is in `objectives.json` (`settings.dailyBudget`).
- Limits: at most 100 active objectives (`LIMITS.maxActive`; the stored list is also capped by `LIMITS.maxTotal`, currently 20); interval 5 to 1440 minutes; an objective may expire (`expiresInDays`) and then pauses itself. Background tasks (session `objective_*` or `agent_*`) may manage objectives like anything else. Duplicate objectives (same template, kind and parameters) are merged.

### Tools, REST and review

Tools: `objective_create`, `objective_update`, `objective_pause`, `objective_resume`, `objective_delete` (all run at once), `objective_list` (read-only). Dutch aliases in `tool-selection.ts` ("houd in de gaten", "monitor", "bewaak", "waarschuw", "laat het me weten", "gezond blijft"). REST: `GET /api/objectives`, `PUT /api/objectives/:id` (title, intervalMinutes, cooldownMinutes, quietHours, expiresInDays, enabled, dismiss), `DELETE /api/objectives/:id`.

Per objective the last 20 results, counters (checks, deviations, reports, suppressed, investigations, false alarms) and the number of deviations in the last 7 days are kept; `objective_list` shows them so NOVA can say "two outages last week". `objective_update` with `dismiss=true` marks the current report as a false alarm: NOVA stays quiet about it until the deviation changes, and the counter stays. Storage is `objectives.json` in the data folder (`0600`, atomic with fsync); only metadata goes to the audit log.

### Known limits

- The investigation is read-only only through its instruction text; `AgentService.start()` has no technical read-only mode, and nothing approves its tool calls, so an investigation can run a changing tool.
- `agenda_leeg` cannot tell whether a calendar is connected; without a connection "empty" counts as a deviation.
- `service_online` uses the target names of `network_check`, not arbitrary host:port.
- The investigation summary also arrives through `AgentService`'s own "Klaar" report, which does not count toward the daily budget.
