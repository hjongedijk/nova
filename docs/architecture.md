# Architecture

## One image, separate services

NOVA ships as one image: the NestJS API serves the built Svelte app as static files, so there is no separate web server. Speech (edge-tts) and NOVA's own tools (Proxmox, timers, lists, checks) become modules of the API, so they need no container of their own. The services NOVA talks to keep their own images: OmniRoute, Mosquitto, Qdrant, Home Assistant, and Node-RED, which is optional and only for your own flows.

All runtime state lives outside the image, in `nova-data/` (production) or `dev-data/` (development): settings, memory, the action log, the MCP workspace, certificates and backups. Nothing in this repository changes at runtime, and no secret is ever committed.

## Rules that keep it clean

- A module in `apps/api` uses another module only through what that module exports (its service), never by importing its files.
- `core/` holds what every module needs (config, security, audit, state, MQTT, HTTP helpers) and knows no domain.
- Components in `apps/web` never call `fetch` themselves; all calls go through `src/lib/api/`.
- Types that cross the API boundary live in `packages/contracts` and are imported with `import type`.

## API modules

One folder per domain under `apps/api/src/`. Everything is ported from the prototype and covered by tests.

| Module                          | Does                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                          | config (`NovaConfig`), `sanitize`, net guard, safe requests, JSON client, audit log, component state, MQTT, error shape                                                                                   |
| `health`                        | `/api/nova/health`                                                                                                                                                                                        |
| `tools`                         | the registry and the one way to run a tool: clean the arguments, check them, decide the real risk, ask for confirmation, write the log. Sources of tools register themselves with `@ToolSourceProvider()` |
| `confirmations`                 | pending confirmations (60 s, single use) and the words for asking and answering                                                                                                                           |
| `chat`                          | `/api/chat`, `/api/chat-stream` (SSE), `/api/actions/confirm`; the orchestrator, prompt, context builder and the spoken summary of command output                                                         |
| `memory`                        | conversations and session context (`memory.json`); long-term memory in Qdrant or OmniRoute; `/api/memories`, `/api/audit`                                                                                 |
| `routing`                       | the free-model policy check against OmniRoute, OmniRoute's management API, `/api/providers`, `/api/gateway`                                                                                               |
| `settings`                      | skills, persona, quick actions, sidebar, custom panels, backup, wallpaper pickers; `/api/settings/*`, `/api/widgets/*`                                                                                    |
| `dashboard`                     | `/api/system`, `/api/overview`, `/api/alerts`, `/api/health`, `/api/integrations`                                                                                                                         |
| `tts`                           | speech with Microsoft's neural voices, in Node                                                                                                                                                            |
| `proxmox`, `planning`, `checks` | the tools that used to run in Node-RED: guests and storage, timers and lists, reachability and alerts                                                                                                     |
| `home`                          | Home Assistant: catalog, tools, risk rules, verification, `/api/entities`                                                                                                                                 |
| `integrations/*`                | `world`, `mcp`, `termix` (with direct SSH fallback), `windows`, `browser-agent`, `pangolin`, `youtube`                                                                                                    |
| `downloads`                     | the Windows agent and the CA certificate, for devices that need them                                                                                                                                      |
| `bridges`                       | the glue where one module needs something another owns by an agreed shape (language model, wallpaper, learned names, home location)                                                                       |

Node-RED is no longer part of NOVA. It stays available as an optional container for your own flows.

## Web

`apps/web/src/`:

- `lib/api/`: one file per API module.
- `lib/entity/`: the particle sphere (canvas).
- `lib/voice/`: speaking, listening, "Hey NOVA", mobile audio unlock.
- `lib/modes/`: wallpaper mode and device detection.
- `lib/stores/`: shared state.
- `components/shell`, `components/hud`, `components/settings`, `components/admin`: one component per part of the screen.

The prototype is one 9,500-line `web/index.html`; it is split into these parts as they are ported.

## Tests

- `apps/api/test`: Vitest. The prototype's tests (`server/test/*.test.js`) are ported along with their module.
- `agents/browser/test`: `node --test`. The contract test against the API client comes back when `integrations/browser-agent` is ported.
- `agents/windows/test/check.ps1`: PowerShell syntax and the embedded C#, also in CI.
- The interface is tested by hand and with the Playwright plugin; there is no e2e suite in the repository.
