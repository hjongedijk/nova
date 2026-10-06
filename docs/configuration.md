# Configuration

NOVA is configured in two places:

1. **Environment variables**, read once at start-up by `apps/api/src/core/config/nova-config.ts` (the single source of truth). In production they come from the `.env` file next to `deploy/docker-compose.yml`; in development from the `.env` in the repository root. [`.env.example`](../.env.example) lists the common ones. Change a value, then recreate the container (`docker compose up -d`).
2. **The Settings screen** in the web interface, stored in `settings.json` in the data folder. See [Settings screen](#settings-screen).

Notes on the tables below:

- Empty or unset means the default applies. Numbers outside their range are clamped; invalid numbers fall back to the default. Booleans are the text `true` or `false`.
- "Secret" marks values that must never be committed or shared. NOVA masks the value of every variable whose name contains `KEY`, `SECRET`, `TOKEN` or `PASSWORD` in logs, the action log, tool results and what the model sees (see [Tools and safety](tools-and-safety.md#secret-sanitising)).
- The `JARVIS_*` names are historical and kept so an old `.env` keeps working.
- In production `deploy/docker-compose.yml` fixes the internal wiring (`PORT`, `HTTPS_PORT`, `NOVA_DATA_DIR`, `OMNIROUTE_URL`, `OMNIROUTE_DATABASE`, `MQTT_URL`, `QDRANT_URL`, `NODE_RED_URL`) in its `environment:` block, which wins over `.env`.

## Release and runtime

| Variable                  | Default                                           | Meaning                                                                                                                                                                                 | Secret |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `NOVA_OWNER`              | `hjongedijk`                                      | Compose only: the GitHub owner in the image name `ghcr.io/<owner>/nova`. Set it if you build and publish your own fork.                                                                 | no     |
| `NOVA_VERSION`            | `latest` (compose), `dev`                         | Compose: the image tag to run. The image also reports it as the version in `/api/nova/health` (the release workflow bakes the tag in).                                                  | no     |
| `NOVA_PUBLIC_URL`         | empty                                             | The address people use behind a reverse proxy, for example `https://nova.example.com`. Only the origin is used. It is the address the Windows agent opens for the wallpaper and helper. | no     |
| `NOVA_ADMIN_PIN`          | empty                                             | PIN for the Settings screen. When set, every settings route needs it. Empty means no PIN.                                                                                               | yes    |
| `TZ`                      | `Europe/Amsterdam`                                | Time zone of NOVA and of the Node-RED and Home Assistant containers.                                                                                                                    | no     |
| `JARVIS_DEFAULT_LANGUAGE` | `nl-NL`                                           | Default language NOVA reports to the interface (`/api/health`).                                                                                                                         | no     |
| `PORT`                    | `3000` (`8080` in the image)                      | HTTP port of the API and the web app.                                                                                                                                                   | no     |
| `HTTPS_PORT`              | `0` (`8443` in the image)                         | HTTPS port. HTTPS only starts when `cert.pem` and `key.pem` exist in the certificate folder.                                                                                            | no     |
| `NOVA_DATA_DIR`           | `../../dev-data` (`/data` in the image)           | Where NOVA keeps its state. `JARVIS_DATA_DIR` is the older name.                                                                                                                        | no     |
| `NOVA_CERT_DIR`           | `<data dir>/certs`                                | Folder with `cert.pem`, `key.pem` and optionally `nova-ca.crt`.                                                                                                                         | no     |
| `NOVA_WEB_DIR`            | `apps/web/build` (`/app/web` in the image)        | The built web app. When absent (development), Vite serves the web app instead.                                                                                                          | no     |
| `NOVA_AGENTS_DIR`         | `agents` in the repo (`/app/agents` in the image) | Where the Windows agent files are served from.                                                                                                                                          | no     |
| `JARVIS_EXTENSIONS`       | `true`                                            | Set to `false` to switch off every tool source except NOVA's own `nova` source (includes MCP, Home Assistant, Proxmox and so on).                                                       | no     |

## AI through OmniRoute

NOVA only talks to language models through [OmniRoute](https://github.com/diegosouzapw/OmniRoute) and only on a route it has verified as free. See [OmniRoute and free routing](omniroute.md).

| Variable                       | Default                     | Meaning                                                                                                                                                                       | Secret |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `OMNIROUTE_URL`                | `http://omniroute:20128/v1` | OpenAI-compatible base URL of OmniRoute. Fixed by compose in production; point it at your own in development.                                                                 | no     |
| `OMNIROUTE_API_KEY`            | empty                       | The OmniRoute API key NOVA uses. Without it the AI is not configured.                                                                                                         | yes    |
| `OMNIROUTE_MODEL`              | `auto`                      | Model or combo name. The free-routing check requires `auto` and the same value in the routing policy.                                                                         | no     |
| `OMNIROUTE_ADMIN_PASSWORD`     | empty                       | Password of the OmniRoute dashboard. Only used for read-only management calls (agent skills, memory, compression, cache stats).                                               | yes    |
| `OMNIROUTE_DATABASE`           | `/omniroute/storage.sqlite` | Path of OmniRoute's SQLite database, opened **read-only** to verify the free policy. Compose mounts `omniroute-data` there.                                                   | no     |
| `JARVIS_OMNIROUTE_COMPRESSION` | `off`                       | `lite` sends OmniRoute's lite compression header with chat requests; anything else sends `off`.                                                                               | no     |
| `FREE_ONLY`                    | `true`                      | Documented switch for free-only routing. In production builds the check is always enforced; see the note in [OmniRoute and free routing](omniroute.md#fail-closed-behaviour). | no     |
| `JARVIS_MAX_TOOL_ITERATIONS`   | `8` (range 1 to 16)         | Maximum number of model rounds (tool-call loops) per message.                                                                                                                 | no     |

## Tools and actions

| Variable                           | Default                                 | Meaning                                                                                                                                                                 | Secret |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `JARVIS_ENABLE_ACTIONS`            | `false`                                 | Master switch for everything that changes something. While `false`, every tool that is not read-only is refused (memory tools excepted). Set `true` when you are ready. | no     |
| `JARVIS_AUTO_EXECUTE_SAFE_ACTIONS` | `true`                                  | `SAFE` actions run without asking. With `false` they need confirmation too.                                                                                             | no     |
| `JARVIS_TOOL_TIMEOUT_MS`           | `30000` (1000 to 60000)                 | Upper bound for one tool call. A tool can lower its own limit but never exceed 60 s.                                                                                    | no     |
| `JARVIS_MCP_CONFIG`                | `<data dir>/mcp-servers.json`           | MCP server list. When the file does not exist, the default list shipped in the image (`NOVA_MCP_DEFAULT`) is used.                                                      | no     |
| `NOVA_MCP_DEFAULT`                 | `/app/mcp-servers.default.json` (image) | The default MCP list, copied from `deploy/mcp-servers.json`.                                                                                                            | no     |
| `JARVIS_TOOL_SHARED_SECRET`        | empty                                   | Reserved for authenticating your own Node-RED flows. NOVA's own code does not use it today; it is only masked in output.                                                | yes    |

## Memory

| Variable                    | Default              | Meaning                                                                                                                               | Secret |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `JARVIS_MEMORY_BACKEND`     | `qdrant`             | Long-term memory backend: `qdrant` or `omniroute` (OmniRoute's native keyword memory, no embeddings needed).                          | no     |
| `QDRANT_URL`                | `http://qdrant:6333` | Qdrant address.                                                                                                                       | no     |
| `QDRANT_COLLECTION`         | `jarvis_memory`      | Collection name. Use a new name when you change embedding model or dimensions.                                                        | no     |
| `QDRANT_API_KEY`            | empty                | Qdrant API key, if you enabled one.                                                                                                   | yes    |
| `EMBEDDING_GATEWAY_API_KEY` | empty                | Separate, restricted OmniRoute key for embeddings. Falls back to `OMNIROUTE_API_KEY`.                                                 | yes    |
| `EMBEDDING_MODEL`           | empty                | Embedding model served by OmniRoute.                                                                                                  | no     |
| `EMBEDDING_DIMENSIONS`      | `0`                  | Vector size of that model.                                                                                                            | no     |
| `EMBEDDING_FREE_VERIFIED`   | `false`              | Set to `true` only when you verified that this embedding model is free for your account. Without it, Qdrant memory stays unavailable. | no     |

Short-term conversation history (`memory.json`) always works and needs none of this.

## Integrations

Each integration is optional and stays off (its tools are listed but disabled) until configured.

| Variable                             | Default                            | Meaning                                                                                                                                                                                                       | Secret |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `PROXMOX_URL`                        | empty                              | Proxmox VE API address, for example `https://pve.example.com:8006`.                                                                                                                                           | no     |
| `PROXMOX_TOKEN_ID`                   | empty                              | API token id, `user@realm!name`.                                                                                                                                                                              | no     |
| `PROXMOX_TOKEN_SECRET`               | empty                              | API token secret.                                                                                                                                                                                             | yes    |
| `PROXMOX_VERIFY_TLS`                 | `true`                             | Set `false` for a self-signed Proxmox certificate.                                                                                                                                                            | no     |
| `HOME_ASSISTANT_URL`                 | `http://host.docker.internal:8123` | Home Assistant address. The bundled container uses host networking on 8123.                                                                                                                                   | no     |
| `HOME_ASSISTANT_TOKEN`               | empty                              | Long-lived access token from your Home Assistant profile.                                                                                                                                                     | yes    |
| `WINDOWS_AGENT_URL`                  | empty                              | `http://<pc-ip>:8765`, printed by the Windows agent installer. Enables the `windows_*` and `browser_*` tools.                                                                                                 | no     |
| `WINDOWS_AGENT_TOKEN`                | empty                              | The agent's bearer token.                                                                                                                                                                                     | yes    |
| `TERMIX_URL`                         | empty                              | Termix address. Enables listing SSH hosts and (confirmed) commands.                                                                                                                                           | no     |
| `TERMIX_API_KEY`                     | empty                              | Termix API key.                                                                                                                                                                                               | yes    |
| `PANGOLIN_URL`                       | empty                              | Pangolin API address.                                                                                                                                                                                         | no     |
| `PANGOLIN_HOST`                      | empty                              | Pangolin host name.                                                                                                                                                                                           | no     |
| `PANGOLIN_API_KEY`                   | empty                              | Pangolin API key.                                                                                                                                                                                             | yes    |
| `PANGOLIN_ORG_ID`                    | empty                              | Pangolin organisation id.                                                                                                                                                                                     | no     |
| `PANGOLIN_INSECURE_TLS`              | `false`                            | Accept a self-signed Pangolin certificate.                                                                                                                                                                    | no     |
| `MQTT_URL`                           | `mqtt://mqtt:1883`                 | MQTT broker. NOVA publishes `jarvis/status/api`, `jarvis/status/proxmox` and `jarvis/events/*`.                                                                                                               | no     |
| `NODE_RED_URL`                       | `http://node-red:1880`             | Only used to show whether the optional Node-RED container is reachable.                                                                                                                                       | no     |
| `JARVIS_HOME_LAT`, `JARVIS_HOME_LON` | empty                              | Home coordinates for the weather tools when Home Assistant has no `zone.home`. Both are needed.                                                                                                               | no     |
| `JARVIS_CHECK_TARGETS`               | NOVA's own stack (see below)       | Reachability checks as `name=url` pairs separated by commas, for example `nas=tcp://192.168.1.20:445,router=http://192.168.1.1/`. `http(s)` targets count as up below status 500; `tcp` targets must connect. | no     |
| `NODE_EXPORTER_URL`                  | `http://host.docker.internal:9100` | Prometheus node exporter of the host, used for the network graph on the dashboard.                                                                                                                            | no     |

The default for `JARVIS_CHECK_TARGETS` still contains container names from the earlier prototype (`jarvis-api`, `jarvis-tts`); in the production stack the app container is called `nova`. Set `JARVIS_CHECK_TARGETS` explicitly to get meaningful checks.

The weather, news, Wikipedia, currency, market, ISS and similar tools use public APIs that need no key (Open-Meteo, Frankfurter, CoinGecko, wheretheiss.at, NOS feeds, Wikipedia, DuckDuckGo HTML search). Speech uses Microsoft's neural voice service through the `msedge-tts` library, so the NOVA host needs outbound internet for these.

## Development-only variables

| Variable            | Default          | Meaning                                                                                        |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `NOVA_DEV_CERT_DIR` | `dev-data/certs` | Folder with `cert.pem` and `key.pem` for the Vite dev server (HTTPS, so the microphone works). |
| `NODE_ENV`          | unset            | `production` in the image. `test` switches off timers, MQTT and the watchdog in tests.         |

## The data folder

Everything NOVA writes lives in the data folder (`nova-data/` in production, `dev-data/` in development):

| File or folder             | What                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`            | Everything from the Settings screen: persona, quick actions, tool switches, skills, panels, sidebar, helper choice. May contain secret header values of skills, so it is readable only by NOVA (mode 0600). |
| `memory.json`              | Short-term conversation history and session context.                                                                                                                                                        |
| `actions.jsonl`            | The action log, one JSON line per event, append-only (mode 0600).                                                                                                                                           |
| `jarvis-state.json`        | Timers, lists, alerts and component state.                                                                                                                                                                  |
| `free-routing-policy.json` | The free-model policy NOVA checks before any inference. See [OmniRoute and free routing](omniroute.md).                                                                                                     |
| `mcp-servers.json`         | Optional own MCP server list (overrides the default).                                                                                                                                                       |
| `workspace/`               | Not created by NOVA: the folder the default `filesystem` MCP server is pointed at (`/data/workspace`). Create it if you want to use that server.                                                            |
| `certs/`                   | `cert.pem`, `key.pem`, optional `nova-ca.crt` for HTTPS.                                                                                                                                                    |

## Settings screen

Open it from the menu in the interface (title "Instellingen"). If `NOVA_ADMIN_PIN` is set it asks for the PIN first. Its tabs:

| Tab                | What you configure                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wat NOVA kan       | "Abilities": the individual tools grouped into things a person understands (weather, lookup and news, timers and lists, smart home, servers, Windows PC, ...). Switch a group or a single tool off, or edit a tool's description. Shows each tool's risk level.                                                                                                                            |
| Eigen vaardigheden | Your own **skills**: instruction skills (a playbook NOVA follows with its existing tools, for example a "movie night" routine) and webhook skills (an HTTP call with your own parameters, which becomes a real tool named `skill_<id>` with risk `READ_ONLY`, `SAFE` or `CONFIRM`). There is an AI assistant to draft and improve skills, a test panel and a run history. Up to 50 skills. |
| Zijbalk            | Which side panels are shown, in which column and on which page, and your **custom panels** (value, list, buttons, note) fed by a web address. Up to 20 custom panels.                                                                                                                                                                                                                      |
| Gedrag             | Sound on this device (voice, "Hey NOVA", microphone test), NOVA's persona and personal rules, and the quick actions on the home screen.                                                                                                                                                                                                                                                    |
| Meer               | Connected devices (the Windows PC: wallpaper per display, helper, mode; agent download), and back-up: export and import of all settings.                                                                                                                                                                                                                                                   |

Settings writes are accepted only from the settings screen (they need the header `x-nova-admin: 1`), are validated like an import, and are written to the action log.
