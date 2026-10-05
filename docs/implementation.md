# JARVIS first-version implementation report

Current native integration is documented in [omniroute-integration.md](omniroute-integration.md): keyword memory now works without embeddings, Agent Skills are discoverable, native compression and session tracking are wired, and gateway status has its own tab. This supersedes the embedding-only memory limitations below.

Implemented on 2026-10-04 in `/opt/jarvis`. Existing JSON messages and provider credentials were preserved. Real Home Assistant device actions and VM power controls were not exercised. The live Home Assistant connection now authenticates and synchronizes 18 entities. Device writes remain disabled by configuration. **Live AI chat is available:** the operator confirmed Gemini, Mistral and Cloudflare account billing limits; 16 matching free native AUTO models are enabled. Headless Chromium verified a real streamed reply. Qdrant runs, but semantic writes/retrieval require a verified free remote embedding provider. These are real onboarding limitations, not simulated working integrations.

## 1. Existing architecture

The nginx HUD used HTTP/SSE to the Express API, OmniRoute for cloud inference, Node-RED for dynamically discovered tools, MQTT for events, and Edge TTS for voice. Conversation history lives in `data/memory.json`. Node-RED owns Proxmox credentials and fixed API paths. All containers intentionally run as root.

## 2. New architecture

Both chat routes share `lib/orchestrator.js`: confirmation handling, routing policy verification, short-term context, selected semantic memory and actual entity catalog, OmniRoute, bounded validated tool calls, backend risk policy, execution, verification, and audit. Existing HTTP/SSE and Node-RED contracts remain. The API talks to Home Assistant over authenticated REST and WebSocket registry commands. Qdrant stores only classified durable memory. OmniRoute remains the only inference and remote embedding gateway; it owns provider selection, quota and resilience.

## 3. Files added

- `server/lib/actions.js`, `risk.js`, `contracts.ts`: HA/media/music/memory tool definitions and execution, risk policy and typed contracts.
- `server/lib/orchestrator.js`, `free-routing.js`, `free-access.js`: unified chat path and fail-closed native routing verification/classification.
- `server/lib/context.js`, `audit.js`, `maintenance.js`: additive session context, private append-only action log and periodic maintenance.
- `server/lib/integrations/home-assistant.js`: real REST/WS catalog and service client.
- `server/lib/semantic/memory.js`: durable classifier, pluggable remote embeddings and Qdrant CRUD/search/dedupe/maintenance.
- `server/test/extensions.test.js`, `migration.test.js`; `tests/fixtures/*.mjs`; `tests/browser/extensions.cjs`.
- `scripts/discover-omniroute.mjs`, `configure-free-routing.py`, `provider-inventory.mjs`, `restore-configuration.py`, `check-syntax.mjs`.
- `docs/omniroute-free-catalog.json`, `provider-inventory.json`, this report; `eslint.config.mjs`, `tsconfig.json`; server dependency lockfile.
- `data/free-routing-policy.json` and `data/actions.jsonl` are runtime data. Private backups are under `backups/20261004T110812Z/`.

## 4. Files modified

`docker-compose.yml`, `.env` (model/free-only only; existing secrets preserved), `.env.example`, root dependency files, `server/package.json`, `Dockerfile`, `server.js`, `app.js`, existing configuration/memory/security/tool/confirmation/prompt/stream/OmniRoute modules, browser HUD, existing backend/browser regression tests, and README. Existing small modules were formatted. Node-RED flow definitions and Proxmox transport remain intact during this upgrade; their previously fixed dispatch and Gemini empty-argument normalization were preserved.

## 5. Database/schema changes

Conversation JSON gains optional per-session `context`; existing message arrays are unchanged. No destructive JSON migration occurs. Audit entries append to a separate JSONL file. Qdrant creates the configured collection only after a remote embedding dimension is verified; payload fields include memory type, text, source, creation/update/access timestamps, importance, confidence, access count, tags, related entity/area/device, embedding model and archival status. The current deployment has no collection yet because embeddings are disabled.

OmniRoute uses its existing SQLite schema. Native settings and the existing NOVA inference key restrictions changed; provider records, encrypted credentials and key values were not deleted or replaced. Configuration restore is tested. Full software rollback additionally requires a prior source/image archive; no such archive was supplied in this workspace.

## 6. Docker changes

Added Qdrant `v1.17.0` on the internal network with the `./qdrant-data:/qdrant/storage` bind mount, and Home Assistant `2026.9.4` with the `./home-assistant-data:/config` bind mount and host networking for LAN discovery/Sonos. Home Assistant uses port 8123. No Qdrant port is exposed externally. nginx now refreshes Docker DNS at runtime so an API container address change after rebuild does not leave the HUD returning 502. API receives HA/Qdrant/action/embedding configuration and a **read-only** mount of the existing OmniRoute directory to verify native policy in its authoritative DB. Provider credentials are neither copied to another store nor returned by the verifier. OmniRoute 3.8.51 is pinned to its installed image digest; its legacy paid/full-pool fallback environment flag is explicitly false.

## 7. Qdrant configuration

Internal URL `http://qdrant:6333`, collection `jarvis_memory`, cosine vectors whose dimension comes from `EMBEDDING_DIMENSIONS`. Different dimensions/distance preserve the existing collection and fail instead of overwriting it. Retrieval filters by embedding model. Change collection names when changing incompatible embedding providers; existing collections remain intact. Optional `QDRANT_API_KEY` belongs in `.env`.

## 8. Memory architecture

Short-term JSON retains messages and adds active entities, active area/media target, ambiguity and eight recent tool summaries. Long-term writes require explicit durable intent or the structured memory tool/admin form. Greetings, temporary requests/current states and credential-bearing content are rejected. All nine requested memory types are supported. Text is normalized, embedded remotely, searched for exact/strong semantic duplicates, and merged without losing creation/access metadata. Search uses relevant scores, importance and age, then updates access counters. Low-importance records unused for 90 days are archived, not destroyed. Maintenance runs daily when configured. Long-term retrieval failure gives no fabricated vectors or memories and does not replace working JSON history. Facts are household-wide across browser sessions; this is the existing single-installation assistant, not a multi-user identity system.

## 9. Embedding provider used

**None enabled.** No embedding endpoint/model has been verified and configured. `RemoteEmbeddings` is a pluggable adapter to OmniRoute `/embeddings`, with bounded remote requests and an in-memory vector cache. It never loads a local model. A separate narrowly restricted OmniRoute inference key can be supplied as `EMBEDDING_GATEWAY_API_KEY`; provider API keys/OAuth remain in OmniRoute. Do not enable `EMBEDDING_FREE_VERIFIED` without account-level free-limit evidence and a model-specific restricted gateway key. The current chat key allows only `auto`, so it cannot be reused for arbitrary embedding models.

## 10–11. Home Assistant configuration and token setup

1. Open **your JARVIS server on port 8123**, finish Home Assistant onboarding and create your own account.
2. In your Home Assistant profile, create a long-lived access token. Put it in `.env` as `HOME_ASSISTANT_TOKEN`; never paste it into chat.
3. Keep `HOME_ASSISTANT_URL=http://host.docker.internal:8123` for the bundled host-network container, or set your existing external HA URL.
4. Add integrations, assign areas/friendly names and aliases. Verify Home Assistant can itself control the intended devices.
5. Recreate the API with `docker compose up -d jarvis-api`. Check `/api/integrations` and `/api/entities`.
6. Set `JARVIS_ENABLE_ACTIONS=true` only when ready to permit device writes, then recreate the API. This flag also gates Proxmox writes; read-only status remains available.

The client synchronizes actual entity/device/area registries via WebSocket and states/services via REST, refreshes at least each minute when configured, and records supported features, capabilities and synchronization/last-seen timestamps. It rejects missing, unavailable or ambiguous targets. Backend risk uses a fresh device state, rather than a cached temperature/volume. The token mechanism is documented by [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).

## 12. Sonos setup

Add Home Assistant's Sonos integration, assign actual speakers to areas, then verify playback there. Group/ungroup uses installed `media_player.join/unjoin` services and registered Sonos devices; these actions require confirmation. Favorites are limited to the source list actually exposed by HA. Text announcements require an installed HA TTS entity; media announcements use a real `media-source://` identifier and never fabricate completion. Sonos announcement playback needs HA-to-speaker connectivity, including the port described in [Sonos documentation](https://www.home-assistant.io/integrations/sonos/). No local TTS/AI model is installed by this project.

## 13–14. Spotify and Music Assistant setup

Install/configure Music Assistant separately, connect it to Home Assistant and add your Spotify account/library within Music Assistant. NOVA detects the installed `music_assistant.play_media` service and sends a structured library search/Spotify URI to an actual HA media player. Missing Music Assistant reports unavailable instead of claiming playback. A dedicated `media_play_media` tool supports an installed HA media-source or Spotify identifier where the player integration supports it. No direct Spotify API credentials or separate Sonos stack were added. See [Music Assistant integration](https://www.home-assistant.io/integrations/music_assistant/).

## 15. Proxmox changes

Existing Node-RED status/nodes/guests/storage/tasks/current-guest tools remain. Start/stop/shutdown/reboot still require the exact session confirmation and shared backend secret. The common executor now polls guest status after accepted start/stop/shutdown actions. A running guest alone does not prove reboot completion; reboot remains explicitly accepted/unverified. No real power action was tested. The existing Gemini synthetic `{reason: ...}` normalization for truly empty argument schemas remains covered by regression tests.

## 16. Tool architecture

The dynamic registry combines validated Node-RED definitions with local integration tools. Each exposes name, description, strict input schema, output schema, source, risk, enabled state and timeout. Tools requiring an unconfigured Home Assistant are omitted from LLM declarations. Optional Sonos/Music Assistant capabilities are detected and reject unsupported requests with explicit errors. Node-RED disappearance does not erase local tools. Backend validates arguments again, resolves actual targets, applies risk and global action gates, logs, executes through a fixed integration endpoint, validates result shape, verifies where supported and records context. Unknown tools, arbitrary services/domains, target overrides, arbitrary playback URLs and malformed data are rejected. There is no raw shell tool or model-generated REST URL.

## 17. Risk and confirmation rules

READ_ONLY executes automatically. SAFE executes automatically unless `JARVIS_AUTO_EXECUTE_SAFE_ACTIONS=false`. CONFIRM and DANGEROUS always require explicit backend confirmation of one exact stored action for the same session within 60 seconds. Confirmations are one-use and bind canonical resolved targets/arguments/risk; wrong sessions/IDs, expired approvals, unrelated messages and rejection do not authorize execution. UI shows targets and requested temperature/volume/group/message where relevant. Bulk operations, scripts, scenes, toggles, grouping and announcements need confirmation. Unlocking and critical infrastructure switches are DANGEROUS. Large volume changes and temperatures outside conservative bounds require confirmation.

## 18. Action verification

Observed light state/brightness/color, media playback/pause/stop/track/volume/mute/group/source and climate setpoint are compared with the requested result. Commands time out and stop further batched work through a shared abort signal. Verification failure is `ok=false, accepted=true, verified=false`. Accepted services without a reliable completion signal, including scenes/scripts/announcements, return `verified=null`. VM completion follows observed guest state; asynchronous/reboot ambiguity is never labelled verified success.

## 19. Audit logging

`data/actions.jsonl` is append-only, mode 0600. Entries include timestamp/ID, session, tool, sanitized arguments, risk, confirmation status, result, verification and duration. Side effects require a writable audit sink before dispatch. Expiration/cancellation are recorded. API exposes a bounded tail via `/api/audit`; HUD shows readable outcomes. No raw credentials, auth headers, complete LLM prompts, intermediate reasoning or complete conversation bodies enter events/logs. Durable explicit facts remain private memory payloads as intended.

## 20–22. OmniRoute model configuration

Installed version is **3.8.51**. Inspection found native `freeAccessPolicy='strict'`, `hidePaidModels=true`, independent ToS filtering, per-connection fresh free quota, native AUTO scoring and failover. Native free-model filtering is enabled; no second provider router/quota counter was added.

The actual previous `.env` value was **`gemini/gemini-3.1-flash-lite`**, not `1`. `1` would be a model/alias string supplied to the gateway; it does not itself mean free or automatic routing. New value is **`OMNIROUTE_MODEL=auto`**, the installed supported native virtual AUTO route. The API rejects client provider/model/route/fallback overrides and rechecks authoritative DB settings/key restrictions before each inference request.

## 23–30. Supported, enabled and excluded providers

`docs/omniroute-free-catalog.json` is dynamically extracted from the **installed** native free-budget module: 489 entries. `docs/provider-inventory.json` classifies all entries and 79 provider groups without exposing account identities or credentials. Catalog support is not proof of current upstream availability or billing safety.

On 4 October 2026 the operator confirmed Gemini, Mistral and Cloudflare accounts have billing disabled or a hard free-tier limit. This attestation is stored in `data/verified-free-accounts.json`. Their 16 matching native AUTO/free-catalog candidates are enabled; all other credentialed and promotional providers remain blocked. Account confirmation does not prove model availability or quota headroom.

Fixed the NOVA API key's connection restriction: OmniRoute requires actual connection IDs, not provider names. Configuration now selects active connections for confirmed providers and records those IDs in the policy. NOVA verifies these restrictions before inference. Provider keys and conversation history are preserved.

The installed native inspector reports `no-hard-stop` for these providers, but a direct native AUTO request still returned a Cloudflare reply. Its static catalog warning is therefore not proof that dispatch is blocked. Safety rests on the operator-confirmed account billing limits, native free-model filtering, and the restricted active connections. Native strict quota mode was disabled after its tool-capability path rejected every confirmed candidate. Native `hidePaidModels`, blocked-provider filtering and actual connection-ID restrictions remain enabled; NOVA requires explicit free-account confirmation when this mode is used. No quota snapshots are available; the UI reports UNKNOWN rather than fabricating headroom. OmniRoute owns quota exhaustion, cooldowns, model selection, and failover. NOVA adds no second router or quota counter.

Unconfirmed recurring accounts still require verified billing, a hard stop and fresh native quota. Confirmed accounts can use their recurring free models without quota telemetry because their account limit prevents charges; known exhausted quotas remain excluded. Paid, trial, local, and non-`:free` OpenRouter candidates remain rejected. No embedding model has been configured.

## 36–37. Health endpoints and environment variables

Existing `/api/health`, `/api/tools`, `/api/chat`, `/api/chat-stream`, `/api/tts` and `/api/memory/:sessionId` remain. Added `/api/integrations`, `/api/providers`, `/api/entities`, `/api/audit`, `/api/memories` (list/write/delete with confirmation), `/api/memories/search`, `/api/actions/execute` and `/api/actions/confirm`. Short-term memory's legacy route does not collide with semantic memory's plural route.

New variables: `FREE_ONLY`, `OMNIROUTE_DATABASE` (read-only authoritative mount), `HOME_ASSISTANT_URL/TOKEN`, `QDRANT_URL/COLLECTION/API_KEY`, `EMBEDDING_GATEWAY_API_KEY/MODEL/DIMENSIONS/FREE_VERIFIED`, `JARVIS_ENABLE_ACTIONS`, `JARVIS_AUTO_EXECUTE_SAFE_ACTIONS`, `JARVIS_MAX_TOOL_ITERATIONS` (default 8). Compose reads configurable internal service URLs from `.env`; `.env.example` contains no real credentials. `FREE_ONLY=false` bypass exists only with `NODE_ENV=test` for isolated fixture tests; production cannot disable the gate through that variable.

## 38–42. Install, migration, testing and restart commands

```bash
cd /opt/jarvis
npm ci
npm ci --prefix server
npx playwright install chromium
node scripts/discover-omniroute.mjs
# Back up and configure native settings only while its writer is stopped:
docker compose stop omniroute
python3 scripts/configure-free-routing.py
docker compose start omniroute
# Wait for OmniRoute to become ready before discovering live candidates:
node scripts/provider-inventory.mjs
docker compose up -d --build

npm run test:backend
npm run lint
npm run typecheck
npm run format:check
node scripts/check-syntax.mjs
npm run test:browser
npm run test:browser:extensions
npm run test:browser:status
```

The configuration migration is repeatable and creates distinct private snapshots of `.env`, SQLite and JSON messages. To restore its configuration snapshot, stop API and OmniRoute, then run:

```bash
docker compose stop jarvis-api omniroute
python3 scripts/restore-configuration.py backups/20261004T110812Z
docker compose up -d
```

Restoration replaces OmniRoute/configuration changes since the snapshot, while preserving current conversation/Qdrant/HA data. The current backend still blocks the unverified legacy Gemini route. Complete software rollback requires restoring your prior source/image archive; it is not the same as a configuration restore.

Type checking covers the executable risk policy and shared tool/action contracts with TypeScript; remaining legacy JavaScript is linted, syntax checked and exercised by tests. All browser suites use Chromium headless. Extension tests launch real HTTP/WS fixtures and the real API/orchestrator in private temporary directories; no real devices, provider quotas or production conversations are used. Failure screenshots and JSON reports live under `artifacts/playwright*/`.

## 43. Supported examples after onboarding and a verified free AUTO account

- “Wat is de status van Proxmox?” uses the existing read-only Node-RED tool.
- “Zet de lamp in het kantoor aan.” resolves an actual entity, executes if safe and verifies.
- “Maak die wat minder fel.” uses the unique recent light target.
- “Pauzeer de Sonos.” / “Zet hem op 25%.” use actual media targets and fresh risk checks.
- “Groeperen: keuken en woonkamer.” requires exact confirmation of actual registered players.
- “Speel Discover Weekly in de keuken.” uses installed Music Assistant/library context.
- “Speel hetzelfde boven.” requires a real playable identifier from the previous player.
- “Kondig aan dat het eten klaar is.” requires an installed TTS entity, actual Sonos target and confirmation.
- “Onthoud mijn volumevoorkeur.” writes durable memory only with configured free remote embeddings.
- “Start VM 104.” requires confirmation and verifies the observed guest state.

Without AI routing, structured read-only tools can still be exercised through `/api/actions/execute`; the HUD status/memory/audit screens still work.

## 44. Remaining limitations and onboarding

Home Assistant is now authenticated and synchronizes 18 real entities; a token was added to `.env` during this run and preserved. Sonos and Music Assistant are not installed/detected. Device writes remain disabled. Music Assistant/Spotify/Sonos must be connected inside HA; installation of an unconfigured music server was not fabricated. No verified free embedding provider or eligible generic AUTO account exists, so live semantic retrieval/writes and AI chat remain blocked. Verifying one existing recurring free account with a hard limit and native quota support is the next routing prerequisite; credentials stay in OmniRoute. Billing verification, account authorization and HA onboarding cannot be inferred from the existing secrets.

Reboot completion, scripts/scenes and announcements may remain unverified; the system states that clearly. Catalog/alias matching is conservative and can ask for clarification. Strong semantic duplicates merge; arbitrary contradictory facts are not automatically reconciled without confidence. Background maintenance archives low-importance stale memory; it does not irreversibly prune important facts. Provider quota exhaustion/failover is mocked, not induced in live accounts. The UI keeps the original HUD and adds an accessible status/admin dialog; reload the browser to see deployed changes.

## Validation results

31 backend/Node-RED tests pass. Chromium headless passes 10 HUD regression scenarios, 10 isolated backend/HA/Qdrant/OmniRoute fixture scenarios, and 2 live read-only desktop/mobile status scenarios: 22 browser checks total. ESLint (including the extracted browser script), scoped TypeScript risk/contracts checks, Prettier, JavaScript syntax, Python script compilation, nginx configuration, and Compose validation pass.

Playwright captured initial mobile-header overflow, a handled-error console regression and the live nginx stale-address 502. Those defects were corrected; failure screenshots are retained alongside passing screenshots and JSON reports. [Validation record](../artifacts/validation.json) lists reports and counts. [Live mobile provider screen](../artifacts/playwright-live-status/providers-320-passed.png) shows the deployed HUD.

A private backup comparison confirms every original session's message array is unchanged. Existing provider credential fields and the original inference key value are preserved. All eight Compose services run. Home Assistant authenticates and discovers 18 entities; Proxmox read-only status, Node-RED, MQTT, TTS and the OmniRoute gateway report online. The free AUTO pool now contains 16 models on confirmed accounts; embeddings and device writes remain disabled. These readiness limits are visible in the HUD instead of being represented as successful integrations.

Existing Qdrant and Home Assistant data was copied to these bind mounts while both services were stopped. The original Docker named volumes are retained for rollback.

Routing follow-up: corrected actual connection-ID restrictions, tested native AUTO, enabled operator-confirmed recurring free accounts, and verified desktop/mobile HUD plus a real streamed web reply with headless Chromium. All 29 backend tests pass. Evidence: `artifacts/playwright-free-routing/report.json`. Test sessions were deleted afterward; existing conversations and credentials were preserved. Native strict quota mode is off because its tool-capability path returned an empty pool; free-model filtering, account limits and connection restrictions remain enforced.

Status-panel follow-up: infrastructure connectivity is shown separately from embedding readiness and disabled device actions. Home Assistant setup instructions are hidden when configured. The free-AI panel shows active providers, with models and diagnostics collapsed. Read-only requests and nginx responses disable caching; panel loads show a timestamp and reject responses for a previously selected view. Live desktop/mobile checks and all ten fixture browser scenarios passed. Screenshots and evidence: `artifacts/playwright-status-cleanup/`.
