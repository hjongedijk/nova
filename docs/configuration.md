# Configuration

NOVA is configured in two places:

1. **Environment variables**, read once at start-up by `apps/api/src/core/config/nova-config.ts` (the single source of truth). In production they come from the `.env` file next to `deploy/docker-compose.yml`; in development from the `.env` in the repository root. [`.env.example`](../.env.example) lists the common ones. Change a value, then recreate the container (`docker compose up -d`).
2. **The Settings screen** in the web interface. NOVA-owned preferences live in `settings.json`; service connections live separately in `services.json`. See [Settings screen](#settings-screen).

Notes on the tables below:

- Empty or unset means the default applies. Numbers outside their range are clamped; invalid numbers fall back to the default. Booleans are the text `true` or `false`.
- "Secret" marks values that must never be committed or shared. NOVA masks the value of every variable whose name contains `KEY`, `SECRET`, `TOKEN` or `PASSWORD` in logs, the action log, tool results and what the model sees (see [Tools and safety](tools-and-safety.md#secret-sanitising)).
- NOVA-prefixed names are the current configuration. The corresponding `JARVIS_*` aliases remain temporarily supported as fallbacks and emit a startup warning when used; set the NOVA name to take precedence.
- In production `deploy/docker-compose.yml` fixes the internal wiring (`PORT`, `HTTPS_PORT`, `NOVA_DATA_DIR`, `NOVA_STACK_CONTROL_URL`, `OMNIROUTE_URL`, `OMNIROUTE_DATABASE`, `MQTT_URL`, `QDRANT_URL`, `NODE_RED_URL`) in its `environment:` block, which wins over `.env`.
- The tables document every variable in [`.env.example`](../.env.example); values owned only by Compose are called out in the relevant rows and the Settings ownership section below.

## Release and runtime

| Variable                   | Default                                           | Meaning                                                                                                                                                                                                                                                                                  | Secret |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `NOVA_OWNER`               | `hjongedijk`                                      | Compose only: the GitHub owner in the image name `ghcr.io/<owner>/nova`. Set it if you build and publish your own fork.                                                                                                                                                                  | no     |
| `NOVA_VERSION`             | `latest` (compose), `dev`                         | Compose: the image tag to run. The image also reports it as the version in `/api/nova/health` (the release workflow bakes the tag in).                                                                                                                                                   | no     |
| `NOVA_PUBLIC_URL`          | empty                                             | The address people use behind a reverse proxy, for example `https://nova.example.com`. Only the origin is used. It is the address the Windows agent opens for the wallpaper and helper.                                                                                                  | no     |
| `NOVA_ADMIN_PIN`           | empty                                             | PIN for the Settings screen. When set, every settings route needs it. Empty means no PIN.                                                                                                                                                                                                | yes    |
| `NOVA_APP_TOKEN`           | empty                                             | Optional app-wide access token. When set, API routes require a 12-hour Secure, HttpOnly, SameSite=Strict browser session, except access bootstrap, health, and Node-RED's separately bearer-authenticated ingress and read-only proactive ask route. Use a long random secret and HTTPS. | yes    |
| `TZ`                       | `Europe/Amsterdam`                                | Time zone of NOVA and of the Node-RED and Home Assistant containers.                                                                                                                                                                                                                     | no     |
| `NOVA_DEFAULT_LANGUAGE`    | `nl-NL`                                           | Default language NOVA reports to the interface (`/api/health`).                                                                                                                                                                                                                          | no     |
| `PORT`                     | `3000` (`8080` in the image)                      | HTTP port of the API and the web app.                                                                                                                                                                                                                                                    | no     |
| `HTTPS_PORT`               | `0` (`8443` in the image)                         | HTTPS port. HTTPS only starts when `cert.pem` and `key.pem` exist in the certificate folder.                                                                                                                                                                                             | no     |
| `NOVA_DATA_DIR`            | `../../dev-data` (`/data` in the image)           | Where NOVA keeps its state. `JARVIS_DATA_DIR` remains a deprecated fallback.                                                                                                                                                                                                             | no     |
| `NOVA_CERT_DIR`            | `<data dir>/certs`                                | Folder with `cert.pem`, `key.pem` and optionally `nova-ca.crt`.                                                                                                                                                                                                                          | no     |
| `NOVA_WEB_DIR`             | `apps/web/build` (`/app/web` in the image)        | The built web app. When absent (development), Vite serves the web app instead.                                                                                                                                                                                                           | no     |
| `NOVA_AGENTS_DIR`          | `agents` in the repo (`/app/agents` in the image) | Where the Windows agent files are served from.                                                                                                                                                                                                                                           | no     |
| `NOVA_RESTART_ENABLED`     | `false` (`true` in official compose)              | Enables a guarded NOVA process restart request. It is enabled only in the official compose deployment with `restart: unless-stopped`.                                                                                                                                                    | no     |
| `NOVA_STACK_CONTROL_URL`   | `http://stack-control:8090` (official compose)    | Compose-only address for the internal stack-control broker. Do not expose this port outside the private network.                                                                                                                                                                         | no     |
| `NOVA_STACK_CONTROL_TOKEN` | empty                                             | Secret shared only by NOVA and the private stack-control broker. Set a 64-character hex token (`openssl rand -hex 32`) to enable fixed stack status and confirmed single-service restarts.                                                                                               | yes    |
| `NOVA_EXTENSIONS`          | `true`                                            | Set to `false` to switch off every tool source except NOVA's own `nova` source (includes MCP, Home Assistant, Proxmox and so on).                                                                                                                                                        | no     |

## AI through OmniRoute

NOVA only talks to language models through [OmniRoute](https://github.com/diegosouzapw/OmniRoute) and only on a route it has verified as free. See [OmniRoute and free routing](omniroute.md).

| Variable                     | Default                     | Meaning                                                                                                                                                                       | Secret |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `OMNIROUTE_URL`              | `http://omniroute:20128/v1` | OpenAI-compatible base URL of OmniRoute. Fixed by compose in production; point it at your own in development.                                                                 | no     |
| `OMNIROUTE_API_KEY`          | empty                       | The OmniRoute API key NOVA uses. Without it the AI is not configured.                                                                                                         | yes    |
| `OMNIROUTE_MODEL`            | `auto`                      | Model or combo name. The free-routing check requires `auto` and the same value in the routing policy.                                                                         | no     |
| `OMNIROUTE_ADMIN_PASSWORD`   | empty                       | Password of the OmniRoute dashboard. Only used for read-only management calls (agent skills, memory, compression, cache stats).                                               | yes    |
| `OMNIROUTE_DATABASE`         | `/omniroute/storage.sqlite` | Path of OmniRoute's SQLite database, opened **read-only** to verify the free policy. Compose mounts `omniroute-data` there.                                                   | no     |
| `NOVA_OMNIROUTE_COMPRESSION` | `off`                       | `lite` sends OmniRoute's lite compression header with chat requests; anything else sends `off`.                                                                               | no     |
| `FREE_ONLY`                  | `true`                      | Documented switch for free-only routing. In production builds the check is always enforced; see the note in [OmniRoute and free routing](omniroute.md#fail-closed-behaviour). | no     |
| `NOVA_MAX_TOOL_ITERATIONS`   | `8` (range 1 to 16)         | Maximum number of model rounds (tool-call loops) per message.                                                                                                                 | no     |

## Tools and actions

| Variable                         | Default                                 | Meaning                                                                                                                                                                 | Secret |
| -------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `NOVA_ENABLE_ACTIONS`            | `false`                                 | Master switch for everything that changes something. While `false`, every tool that is not read-only is refused (memory tools excepted). Set `true` when you are ready. | no     |
| `NOVA_AUTO_EXECUTE_SAFE_ACTIONS` | `true`                                  | `SAFE` actions run without asking. With `false` they need confirmation too.                                                                                             | no     |
| `NOVA_TOOL_TIMEOUT_MS`           | `30000` (1000 to 60000)                 | Upper bound for one tool call. A tool can lower its own limit but never exceed 60 s.                                                                                    | no     |
| `NOVA_MCP_CONFIG`                | `<data dir>/mcp-servers.json`           | MCP server list. When the file does not exist, the default list shipped in the image (`NOVA_MCP_DEFAULT`) is used.                                                      | no     |
| `NOVA_MCP_DEFAULT`               | `/app/mcp-servers.default.json` (image) | The default MCP list, copied from `deploy/mcp-servers.json`.                                                                                                            | no     |

## Memory

| Variable                    | Default              | Meaning                                                                                                                                                  | Secret |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `NOVA_MEMORY_BACKEND`       | `qdrant`             | Long-term memory backend: `qdrant` or `omniroute` (OmniRoute's native keyword memory, no embeddings needed).                                             | no     |
| `QDRANT_URL`                | `http://qdrant:6333` | Qdrant address.                                                                                                                                          | no     |
| `QDRANT_COLLECTION`         | `jarvis_memory`      | Semantic memory collection name. The document library gets its own derived collection. Use a new name when changing dimensions.                          | no     |
| `QDRANT_API_KEY`            | empty                | Qdrant API key, if you enabled one.                                                                                                                      | yes    |
| `EMBEDDING_GATEWAY_API_KEY` | empty                | Must be empty or match `OMNIROUTE_API_KEY`; a separate key is rejected until its provider and free-model policy can be verified.                         | yes    |
| `EMBEDDING_MODEL`           | empty                | Embedding model served by OmniRoute.                                                                                                                     | no     |
| `EMBEDDING_DIMENSIONS`      | `0`                  | Vector size of that model.                                                                                                                               | no     |
| `EMBEDDING_FREE_VERIFIED`   | `false`              | Set to `true` only when you verified that this embedding model is free for your account. Without it, Qdrant memory and document search stay unavailable. | no     |

Short-term conversation history (`memory.json`) always works and needs none of this.

## Integrations

Each integration is optional and stays off (its tools are listed but disabled) until configured.

| Variable                         | Default                            | Meaning                                                                                                                                                                                                                                                                                                                           | Secret |
| -------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `PROXMOX_URL`                    | empty                              | Proxmox VE API address, for example `https://pve.example.com:8006`.                                                                                                                                                                                                                                                               | no     |
| `PROXMOX_TOKEN_ID`               | empty                              | API token id, `user@realm!name`.                                                                                                                                                                                                                                                                                                  | no     |
| `PROXMOX_TOKEN_SECRET`           | empty                              | API token secret.                                                                                                                                                                                                                                                                                                                 | yes    |
| `PROXMOX_VERIFY_TLS`             | `true`                             | Set `false` for a self-signed Proxmox certificate.                                                                                                                                                                                                                                                                                | no     |
| `HOME_ASSISTANT_URL`             | `http://host.docker.internal:8123` | Home Assistant address. The bundled container uses host networking on 8123.                                                                                                                                                                                                                                                       | no     |
| `HOME_ASSISTANT_TOKEN`           | empty                              | Long-lived access token from your Home Assistant profile.                                                                                                                                                                                                                                                                         | yes    |
| `CALDAV_URL`                     | empty                              | Optional HTTPS URL of one CalDAV calendar collection. NOVA reads upcoming events and can create or move events after fresh confirmation.                                                                                                                                                                                          | no     |
| `CALDAV_USERNAME`                | empty                              | CalDAV account name, kept on the NOVA server.                                                                                                                                                                                                                                                                                     | yes    |
| `CALDAV_PASSWORD`                | empty                              | CalDAV account or app password, kept on the NOVA server. Calendar titles and times are treated as untrusted data.                                                                                                                                                                                                                 | yes    |
| `NTFY_URL`                       | empty                              | Optional ntfy server URL. HTTPS is required except for local `ntfy`, `localhost`, or `127.0.0.1` HTTP endpoints.                                                                                                                                                                                                                  | no     |
| `NTFY_TOPIC`                     | empty                              | Private ntfy topic name; 1–128 letters, numbers, `_` or `-`.                                                                                                                                                                                                                                                                      | no     |
| `NTFY_TOKEN`                     | empty                              | ntfy publish access token (minimum 12 characters). NOVA pushes only critical alert titles.                                                                                                                                                                                                                                        | yes    |
| `WINDOWS_AGENT_URL`              | empty                              | `http://<pc-ip>:8765`, printed by the Windows agent installer. Enables the `windows_*` and `browser_*` tools.                                                                                                                                                                                                                     | no     |
| `WINDOWS_AGENT_TOKEN`            | empty                              | The agent's bearer token.                                                                                                                                                                                                                                                                                                         | yes    |
| `TERMIX_URL`                     | empty                              | Termix address. Enables listing SSH hosts and (confirmed) commands.                                                                                                                                                                                                                                                               | no     |
| `TERMIX_API_KEY`                 | empty                              | Termix API key.                                                                                                                                                                                                                                                                                                                   | yes    |
| `PANGOLIN_URL`                   | empty                              | Pangolin API address.                                                                                                                                                                                                                                                                                                             | no     |
| `PANGOLIN_HOST`                  | empty                              | Pangolin host name.                                                                                                                                                                                                                                                                                                               | no     |
| `PANGOLIN_API_KEY`               | empty                              | Pangolin API key.                                                                                                                                                                                                                                                                                                                 | yes    |
| `PANGOLIN_ORG_ID`                | empty                              | Pangolin organisation id.                                                                                                                                                                                                                                                                                                         | no     |
| `PANGOLIN_INSECURE_TLS`          | `false`                            | Accept a self-signed Pangolin certificate.                                                                                                                                                                                                                                                                                        | no     |
| `MQTT_URL`                       | `mqtt://mqtt:1883`                 | MQTT broker for NOVA's outbound event/status broadcasts. Topic list and payload boundaries: [Node-RED/MQTT guide](node-red-mqtt.md).                                                                                                                                                                                              | no     |
| `NODE_RED_URL`                   | `http://node-red:1880`             | Address of the required Node-RED service in the Docker stack. NOVA reads a bounded flow-tab count.                                                                                                                                                                                                                                | no     |
| `NODE_RED_ADMIN_TOKEN`           | —                                  | Optional server-only bearer token for flow inventory (`flows.read`) and confirmed allow-listed enable/disable (`flows.write`). Flow changes use Node-RED's revision-aware Admin API and are verified after deployment. Never returned to the browser.                                                                             | yes    |
| `NODE_RED_PALETTE_ALLOWLIST`     | `[]`                               | Exact JSON list of `node-red-node-*` or `node-red-contrib-*` package names allowed in Settings → Node-RED palette (max 20). Node inventory needs `nodes.read`; install/remove needs `nodes.write`. The Node-RED API installs the current npm release and cannot pin a version; keep this list empty unless that risk is accepted. | no     |
| `NODE_RED_EDITOR_URL`            | —                                  | Optional browser-reachable Node-RED editor URL shown in Settings. Production does not publish the editor by default; expose it only through your chosen authenticated access path. NOVA strips credentials and query data.                                                                                                        | no     |
| `NODE_RED_EVENT_TOKEN`           | —                                  | Private bearer token for allow-listed Node-RED event callbacks and the restricted read-only `/api/proactive/ask` endpoint used by scheduled briefing templates. Generate with `openssl rand -hex 32`; configure the same value for NOVA and Node-RED.                                                                             | yes    |
| `NODE_RED_FLOW_ALLOWLIST`        | `[]`                               | One-line JSON array of flows NOVA may trigger. Each item needs a fixed `id`, display `label` and `risk` (`READ_ONLY`, `SAFE`, `CONFIRM` or `DANGEROUS`); optional `description` and Node-RED tab `tabId` to expose its Settings action. IDs map only to `/_nova/flow/<id>`.                                                       | no     |
| `OPENROUTESERVICE_API_KEY`       | empty                              | Optional free Standard key for explicit city-to-city route estimates; absent key hides the route tool. Kept server-side. See [routes](routes.md).                                                                                                                                                                                 | yes    |
| `NODE_RED_FLOW_TOKEN`            | —                                  | Private bearer token shared only with allow-listed Node-RED HTTP-in flows. Generate with `openssl rand -hex 32`; without a 32-character token, flow-trigger tools stay unavailable.                                                                                                                                               | yes    |
| `NOVA_HOME_LAT`, `NOVA_HOME_LON` | empty                              | Home coordinates for the weather tools when Home Assistant has no `zone.home`. Both are needed.                                                                                                                                                                                                                                   | no     |
| `NOVA_CHECK_TARGETS`             | NOVA's own stack (see below)       | Reachability checks as `name=url` pairs separated by commas, for example `nas=tcp://192.168.1.20:445,router=http://192.168.1.1/`. `http(s)` targets count as up below status 500; `tcp` targets must connect.                                                                                                                     | no     |
| `NODE_EXPORTER_URL`              | `http://host.docker.internal:9100` | Prometheus node exporter of the host, used for the network graph on the dashboard.                                                                                                                                                                                                                                                | no     |

NOVA currently publishes status and event broadcasts over MQTT and does not subscribe to a command topic. A bounded HTTP callback accepts only authenticated Node-RED alerts and runtime-error reports; flow triggering remains unimplemented. See the [current MQTT/HTTP contract](node-red-mqtt.md) before connecting flows.

Node-RED is required by the production and development Compose stacks. Production keeps its editor/API on the private Compose network; development binds the editor to `127.0.0.1:1880`. The `deploy/nodered/` files seed an empty `/data` directory once, while `nodered-data/` remains authoritative for flows, credentials, settings, and installed nodes. The startup seed never overwrites files already present there. See [Node-RED seed and persistence](../deploy/nodered/README.md).

Production Compose mounts the NOVA application-data archives from `nova-backups/` at `/backups`. `NOVA_BACKUP_DIR` selects the archive directory (default: a sibling of `NOVA_DATA_DIR` outside Compose). See [scheduled data backups](data-backups.md) for schedule, local-only scope, and retention.

When `NOVA_CHECK_TARGETS` is empty, NOVA checks its own `/api/health` endpoint and the Compose services `omniroute`, `mqtt`, `node-red` and `qdrant`. Optional host services such as Home Assistant are not probed unless explicitly configured.

The weather, news, Wikipedia, currency, market, ISS and similar tools use public APIs that need no key (Open-Meteo, Frankfurter, CoinGecko, wheretheiss.at, NOS feeds, Wikipedia, DuckDuckGo HTML search). Speech uses Microsoft's neural voice service through the `msedge-tts` library, so the NOVA host needs outbound internet for these.

## Development-only variables

| Variable            | Default          | Meaning                                                                                        |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `NOVA_DEV_CERT_DIR` | `dev-data/certs` | Folder with `cert.pem` and `key.pem` for the Vite dev server (HTTPS, so the microphone works). |
| `NODE_ENV`          | unset            | `production` in the image. `test` switches off timers, MQTT and the watchdog in tests.         |

## The data folder

Everything NOVA writes lives in the data folder (`nova-data/` in production, `dev-data/` in development):

| File or folder                                                                        | What                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`                                                                       | NOVA-owned preferences: persona, quick actions, tool switches, skills, panels, sidebar, helper choice and preferences, plus scoped standing approvals. May contain skill secret headers; mode 0600. |
| `services.json`                                                                       | Service connection values and bounded connection history. Secret fields are private; mode 0600.                                                                                                     |
| `helper-preferences-history.json`, `tool-switch-history.json`, `sidebar-history.json` | Bounded private change histories for helper appearance, tool enabled states and sidebar layout. Each is written with mode 0600.                                                                     |
| `persona-history.json`                                                                | Private history of up to 100 changes to the user's behavior rules; full text is shown only after the PIN-protected history is loaded. Mode 0600.                                                    |
| `memory.json`                                                                         | Short-term conversation history and session context.                                                                                                                                                |
| `notes/`                                                                              | Private notes and diary entries; directory mode 0700, files mode 0600. See [Private notes](notes.md).                                                                                               |
| `actions.jsonl`                                                                       | The action log, one JSON line per event, append-only (mode 0600).                                                                                                                                   |
| `jarvis-state.json`                                                                   | Timers, named user lists, alerts and component state. Only named lists are included in settings backups; active timers and alerts remain local.                                                     |
| `settings-import-transaction.json`                                                    | Short-lived 0600 recovery journal while a confirmed import updates settings and named lists; removed after both stores commit.                                                                      |
| `free-routing-policy.json`                                                            | The free-model policy NOVA checks before any inference. See [OmniRoute and free routing](omniroute.md).                                                                                             |
| `mcp-servers.json`                                                                    | Optional own MCP server list (overrides the default).                                                                                                                                               |
| `mcp-secrets.json`                                                                    | Optional CalDAV/IMAP settings entered in Settings; values are local-only with mode 0600. Deployment `.env` can still supply initial defaults.                                                       |
| `workspace/`                                                                          | Not created by NOVA: the folder the default `filesystem` MCP server is pointed at (`/data/workspace`). Create it if you want to use that server.                                                    |
| `certs/`                                                                              | `cert.pem`, `key.pem`, optional `nova-ca.crt` for HTTPS.                                                                                                                                            |

## Settings screen

Open **Instellingen** from the main menu, or `/settings?section=general`. The page has twelve sections and search.
Deep links use `section=voice`, `personality`, `models`, `abilities`, `skills`, `automation`, `connections`,
`devices`, `memory`, `safety` or `system`. The inventory and screenshots are in [settings design](settings-design.md).
If `NOVA_ADMIN_PIN` is set, unlock first. The PIN stays only in browser memory, expires after fifteen minutes,
and can be cleared with **Instellingen vergrendelen**. Repeated wrong guesses are throttled by the API.

Settings HTTP writes are accepted only from the settings screen (they need the header `x-nova-admin: 1`), are validated like an import, and are written to the action log.

## Settings workspace

Open `/settings` from NOVA's menu. Each section has a stable deep link, for example
`/settings?section=voice`, `/settings?section=skills` or `/settings?section=system`.
Search accepts names such as “stem”, “model” and “back-up”; press Enter to open the first match.
Existing skills, widgets, sidebar layout, persona and quick actions retain their storage and APIs.
See [settings inventory](settings-inventory.md) and [service inventory](settings-services-inventory.md)
for which values are still environment-only while phase J is in progress.

### What the Settings screen can change

The **Connections** and **Devices** sections can save connection addresses and credentials for
OmniRoute, Home Assistant, Proxmox, Qdrant, MQTT, Node-RED, the Windows agent, Termix and Pangolin.
These saved values override the corresponding environment bootstrap values after NOVA starts;
the UI marks changes that need a restart. Secret values stay server-side in `services.json` and are
never exported. The Models section also reads account/model metadata and can write NOVA's verified
free-routing policy, but it does not edit provider credentials or OmniRoute's upstream route/model
settings.

Persona, quick actions, tool overrides, skills, widgets, sidebar layout, helper mode/display and
helper appearance preferences are stored in `settings.json`. The MCP server list is an editable data
file, not yet a Settings editor. Node-RED flow configuration remains owned by Node-RED and is not
managed from the Settings screen.

### Values that remain environment or deployment controlled

The service fields above use `.env` or compose as their initial values. The following controls do
not have a Settings editor: public URL and Settings PIN; language/time zone; ports and data/certificate
paths; OmniRoute's required `auto` model, mounted database path and compression mode; global action
policy and tool-call limits; MCP file path; memory backend and embedding model/dimensions; weather
fallback coordinates; Node-RED shared secret; reachability-check targets; host metrics address; and the
default TTS voice (`TTS_VOICE`, one of the voices listed in Sound settings). A saved browser voice
choice takes precedence for speech from that browser; the default applies when no valid choice exists.
Sound settings offer 20 Microsoft Edge neural voices across Dutch, English, German, French, Spanish,
Italian, Brazilian Portuguese and Japanese. Speech recognition follows the selected voice locale.
The free-only routing verifier remains mandatory in production, regardless of `FREE_ONLY`. Change
deployment variables in compose/`.env` and recreate the NOVA container. `NOVA_RESTART_ENABLED` is
the exception: the official compose file sets it so NOVA can request its own supervised restart after
a guarded confirmation.

### Docker stack control

The Connections section reads the fixed Compose service states through a small broker. It can restart one
running application service after a fresh, one-use DANGEROUS confirmation, and rechecks the service revision immediately
before restarting it. To enable it, set `NOVA_STACK_CONTROL_TOKEN` in the deployment `.env` to a random
64-character hex value. The NOVA API container has no Docker socket. The broker is attached only to a private
network shared with NOVA, accepts only fixed service names, exposes no container IDs, and has read-only rootfs,
no Linux capabilities, and resource limits. It still needs the Docker socket to carry out restarts; a compromise
of this broker would grant Docker-daemon-level host control, so keep the image trusted and updated. If the token
is absent or invalid, status and restart stay unavailable.

When a PIN is configured, it is held only in browser memory for fifteen minutes. Reloading the page,
closing the tab or choosing “Instellingen vergrendelen” requires entering it again.
Five incorrect supplied PINs block that client for five minutes; ordinary requests without a PIN
show the unlock form without counting as failed attempts.

For app-wide protection, set `NOVA_APP_TOKEN` to a long random value, for example the output of
`openssl rand -base64 32`. The browser exchanges it for a 12-hour secure session cookie; the token
stays in memory only until unlock succeeds and is never stored in browser storage. HTTPS is required.
Sessions live in API memory, so restarting NOVA logs browsers out. The health probe, access bootstrap
and separately bearer-authenticated Node-RED event ingress and read-only proactive ask route remain
available without this session.

The page transition keeps one private, server-local snapshot named `settings.json.before-settings-page-v1`.
It is readable only by NOVA, includes existing private skill configuration and is never part of a download.
See [settings design and preservation](settings-design.md) for rollback and screenshot evidence.

### Service connections managed in NOVA

The Models, Connections and Devices sections edit OmniRoute, Home Assistant, Proxmox, Qdrant, MQTT,
Node-RED, Windows-agent, Termix and Pangolin connection settings. Saved fields in `/data/services.json`
override environment bootstrap values on the next NOVA start. This private file is written atomically
at mode 0600. Blank replacement-secret fields keep their old value; an explicit erase checkbox clears it.
Credentials are never returned to the browser or stored in the visible history.

The Node-RED connection includes a masked admin-token replacement field. Its saved value overrides
`NODE_RED_ADMIN_TOKEN` after NOVA restarts. The read-only connection test sends the effective token
to `/settings`; it does not change Node-RED or prove permission to edit flows or install nodes.
Node-specific credentials and Node-RED runtime settings are not managed by this connection editor.

Connection tests use unsaved input without persisting it. They issue bounded read-only HTTP requests
or open and close an MQTT connection without publishing. A successful response proves reachability,
not free billing, complete tool access or action verification. The screen distinguishes saved values
from the running connection and shows when NOVA must be restarted. In the official Compose deployment,
the guarded Restart NOVA button is available when supported changes are pending; the process exits
gracefully and Compose restarts it. Other deployment forms show the restart-required message only.

OmniRoute inference remains bound to the environment endpoint whose mounted database NOVA verifies.
A different saved endpoint blocks inference, including test bypasses, and a connection probe refuses
to send credentials to that unverified target. Updating the gateway requires a matching trusted
deployment and a new free-route check; changing a URL alone cannot establish that trust.

The Personality section loads the private behavior-rule history on request. Recognizable bearer tokens,
API keys and password assignments are redacted before history is stored or restored. The System section loads
connection, helper preference, tool switch and sidebar layout histories on request. Each history stores
at most 100 private revisions and shows at most 50. Rollback checks
that the values being restored still match the recorded change; unrelated edits stay untouched.
Connection credentials remain outside the visible history and require entering the desired value
again. Tool history contains only tool names and enabled states. Sidebar history contains only panel
placement and visibility, never panel content, prompts or source addresses.

Version-one settings backups include persona, quick actions, tool overrides, skills, widgets, sidebar layout, helper appearance and helper sound preferences, plus named user lists such as shopping and to-do lists. New exports also include service addresses and non-authentication options. Service passwords, API keys, tokens and usernames are never exported; merge and replace both retain them on the destination installation. Older v1 files that omit lists or connections preserve current values in both merge and replace modes. Active timers, alerts and watchdog state are excluded. List imports are bounded to 100 lists with at most 100 items each; merge updates matching item IDs or text and replace applies only when a `lists` field is present. Helper mode and display are included as saved choices only; import never commands the Windows agent to apply them. Import first validates a detached candidate (maximum 1,000,000 bytes) and shows changed categories, service destinations, additions, replacements, removals and missing secret header names. It requires a fresh DANGEROUS confirmation valid for 60 seconds and one use; changing settings, lists or service connections in the meantime invalidates the import. Preparation never writes settings or contacts the listed services. A private recovery journal restores the prior settings, lists and service configuration on startup if a process stops during the multi-file commit. Changed service destinations require a service restart; preserved credentials may be used against the imported destination after restart. Unknown versions, invalid modes, duplicate IDs, over-capacity merges and broken widget/sidebar references are rejected rather than silently truncated.

Secret header values are never exported or restored from a file. A merge retains existing private headers only when the target URL, method and declared header names match exactly; changed targets require entering the secrets again. Recognized secrets and declared credential values in visible imported settings are rejected before any write. The public confirmation and audit contain counts only; candidates and revision hashes remain private and expire autonomously. Permanent approval grants cannot be imported. An audit failure before applying blocks the import; a failure after saving produces an explicit warning.

The guarded API uses POST `/api/settings/import/prepare` with `{data, mode, acknowledgeEffects: true}`. POST `/api/settings/import` now accepts only `{sessionId, confirmationId, approve}` from that preparation; old direct-import bodies are rejected. The settings screen performs both steps and supports cancellation and expiry.

The version-one download includes local quick-action, widget and named planning lists, safe service connection
fields, and the other fields above. It excludes provider/model accounts, Node-RED flows, secret values,
standing permissions, native hotkeys, memories and conversation history. Complete-system export/import remains
unfinished until the Node-RED flow owner and upstream account/model backup contracts are established. Flow backup
depends on its management API and repository ownership work in phases C and J4.

## Tool usage and standing permissions

**Vaardigheden** includes the existing tool list with source, risk, enable switch and description editor, the current “Altijd” permission list with revocation, and an explicit **Gebruiksstatistieken laden** button. The PIN-guarded GET `/api/settings/tools/usage` projects metadata and counts from at most 500 entries in the last 2 MB of the existing audit log. Only tools in the current registry appear. Loading does not execute tools or contact their services.

A recorded terminal attempt requires a valid timestamp, bounded duration and boolean result. Preparation, confirmation requests, execution-start records, cancellation and grant-creation records do not count. OK-result counts describe the reported result and do not prove a physical device effect. The report gives attempts, OK/error totals, average duration, last recorded attempt and fixed chat/settings/background/unknown context buckets. It returns no arguments, responses, errors, approval hashes or session identifiers. Quiet dashboard calls intentionally produce no audit entries and are absent; this bounded tail is not a lifetime usage total. Unused current tools are optional in the display.

## Model observations and release checks

**Modellen** shows rolling gateway measurements for the past 24 hours: requests, failures, average latency,
time to first token and output speed. The gateway may serve other clients, so these aggregates are not
NOVA-only. Only identifiers and numbers are projected; request bodies, account details and credentials are excluded.
The last completed NOVA model response is held in private volatile memory since boot and is available only
through the guarded settings endpoint. It is excluded from public component status and model prompts.
No active inference probe runs; a historical success does not prove current availability or free billing.
The existing fail-closed route verifier remains authoritative.

**Systeem** shows the running `NOVA_VERSION` and an explicit **Controleer op nieuwe release** button.
Opening the page does not contact GitHub. A check reads the public latest stable release of `hjongedijk/nova`,
without credentials; concurrent checks are shared and results cached for five minutes. Release notes are
rendered as plain text, bounded to 12,000 characters. Redirects, excessive responses, malformed releases,
network failures and rate limits produce generic Dutch errors. The check does not install or restart anything.
Development builds cannot be compared with release numbers. A failed refresh retains the last fetched release,
with an explicit error and check timestamp.

## Windows status and shortcuts

**Apparaten** combines the running Windows-agent version, helper open/paused state, actual mode and helper display,
shortcut editing, existing mode/display controls and the bundled agent download. The status endpoint is PIN-protected
and projects only those fields; it excludes hostname, username, app/process inventories and raw upstream errors.
Older agents may omit fields, which appear as unknown. Shortcut controls remain disabled until the agent returns
all four current shortcuts. Saving writes only those shortcut names, needs settings authorization and uses the
existing audit path. Agent warnings and failed acknowledgements remain visible. A download is the agent bundled
with this NOVA build; checking the latest NOVA release is a separate explicit action in **Systeem**.
No status test opens the helper, changes a display or starts a process.

### Personal changes through chat

NOVA can replace personal conversation rules, add an instruction skill and enable or disable an existing instruction skill. Each change asks for a fresh confirmation and is audited; these tools cannot use a standing approval. Credentials, service settings and webhook bindings remain in the settings screen. Night-mode and model-selection chat controls are still pending. See [tools and safety](tools-and-safety.md#personal-settings-through-chat).

### Native OmniRoute overview

In Models, click **OmniRoute-overzicht laden** to inspect native executable skill metadata owned by NOVA or shared globally, the separate documentation catalog, instance-wide prompt status/size and OmniRoute memory status. The overview requires settings authorization and the original verified gateway endpoint. It performs only fixed management reads; other owners, handler code and prompt contents are excluded. At most the first 200 runtime entries are inspected, with an explicit notice when more exist. Gateway skill status may be cached for one minute. NOVA-owned native skill modes can be changed after a fresh 60-second confirmation. Enabling or automatic mode is classified DANGEROUS; disabling is CONFIRM. Shared skill modes affect every gateway client, require an explicit acknowledgement and a fresh DANGEROUS confirmation. The memory switch also affects every gateway client, warns that enabled memory can add context tokens, and changes only OmniRoute's `enabled` setting after a fresh DANGEROUS confirmation and stale-settings check. Each approval is single-use and checks ownership and a private code/configuration revision. Skill persistence is verified through the read-only mounted database; overlapping changes to the same skill are refused. Installing skills and editing handlers remain unavailable. Safe gateway-prompt revisions are stored locally for rollback drafts; global prompt replacement retains its separate risk confirmation. NOVA's own skills and memory keep their existing editors. In Accounts and catalog, **Verborgen modellen bekijken** reads OmniRoute's `hiddenModelsByProvider` metadata on request. This means those models are hidden from the model catalog; direct API invocation may still work, so it does not disable or secure a model.

App access covers direct Settings and Helper links as well as the main screen.
Expired API sessions restore the access form before private page content remains
mounted. The form also fits the compact 360×44 helper. For Node-RED integration,
keep its private `NOVA_APP_TOKEN` environment value synchronized with NOVA and use
local node package 0.1.2 or later. Tokens remain outside flow configuration and
messages. Bearer-protected events and read-only proactive asks remain independent.
