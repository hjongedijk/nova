# Current state

A short map of what exists and where it lives. It is navigation, not proof: check it against the code and `git log`.
Per-version history is in [release notes](release-notes/) and Git; the task list is [tasks-09-10-2026.md](../tasks-09-10-2026.md).
Do not record credentials, personal messages or real deployment configuration here.

## What exists

One Docker image (`ghcr.io/<owner>/nova`) holds the NestJS API (`apps/api`) and the built SvelteKit app (`apps/web`); shared types are in `packages/contracts`. Details: [Architecture](architecture.md).

| Area                                   | Where                                                                                                             | Doc                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Chat, prompt, streaming, tool loop     | `apps/api/src/chat/`, `tools/`, `confirmations/`                                                                  | [Tools and safety](tools-and-safety.md)                                                              |
| Free routing (fail-closed) and roles   | `apps/api/src/routing/`, `chat/omniroute-client.service.ts`                                                       | [OmniRoute](omniroute.md), [Admin API](omniroute-admin-api.md)                                       |
| Settings, guard, backups, history      | `apps/api/src/settings/`, `apps/web/src/routes/settings/`, `components/settings/`                                 | [Settings design](settings-design.md), [inventory](settings-inventory.md)                            |
| Runtime configuration                  | `apps/api/src/core/config/nova-config.ts`, `service-connections.ts`                                               | [Configuration](configuration.md), [services inventory](settings-services-inventory.md)              |
| Dashboard, alerts, rituals, briefings  | `apps/api/src/dashboard/`, `checks/`, `planning/`, `proxmox/`, `home/`, `integrations/world/`                     | [Planning lists](planning-lists.md), [Proactive speech](proactive-speech.md)                         |
| Memory (Qdrant lifecycle, notes, docs) | `apps/api/src/memory/`, `notes/`                                                                                  | [Memory](memory.md), [Long-term memory](long-term-memory.md), [Notes](notes.md)                      |
| Standing objectives, background agent  | `apps/api/src/objectives/`, `agent/`, `planning/autonomy/`                                                        | [Objectives](objectives.md)                                                                          |
| Voice (TTS, wake word, hands-free)     | `apps/api/src/tts/`, `apps/web/src/lib/voice/`                                                                    | [Speech presence](speech-presence.md), [Conversations](conversations.md)                             |
| Telephony (Asterisk, Linphone)         | `apps/api/src/telephony/`, `conversation/`, `deploy/asterisk/`                                                    | [Telephony](telephony.md)                                                                            |
| Holographic cards and viewer           | `apps/api/src/visualization/`, `apps/web/src/lib/holo/`, `components/holo/`                                       | [Holographic engine](holographic-engine.md)                                                          |
| Desktop control, Windows agent, helper | `apps/api/src/desktop/`, `agents/windows/`, `apps/web/src/routes/helper/`                                         | [Windows agent](windows-agent.md), [Desktop control](desktop-control.md), [Helper](helper-design.md) |
| Node-RED, MQTT, stack control, MCP     | `deploy/nodered/`, `deploy/stack-control/`, `deploy/mcp-servers*`, `apps/api/src/integrations/mcp/`, `core/mqtt/` | [Node-RED](node-red-flows.md), [MCP policy](mcp-server-policy.md)                                    |
| Evaluation of models and personas      | `scripts/evaluate-*.mjs`, `scripts/test-*-evaluation*.mjs`                                                        | [Code evaluation](code-evaluation.md), [Persona evaluation](persona-evaluation.md)                   |

Settings screens, the free-policy wizard and every history/rollback panel sit behind the PIN guard (`settings/settings.guard.ts`, browser credential `apps/web/src/lib/api/pin-session.ts`). Never bypass the fail-closed free-route check in `routing/`.

## How to run the gates

Use Node 24 (`.nvmrc`).

```sh
npx prettier --check . && npx eslint .
npm run typecheck                                  # contracts, API, svelte-check
cd apps/api && npx vitest run                      # API tests
npm -w apps/web test                               # web unit tests
npm run build
npm run test:model-evaluation                      # offline evaluator tests
```

CI (`.github/workflows/ci.yml`) also runs the privacy OCR check on `docs/img`, the Node-RED flow checks, the briefing and notification runtime scripts, the MCP sandbox tests and the PowerShell checks for the Windows agent. Playwright browser checks (`scripts/check-helper.mjs`, `check-settings*.mjs`, `check-holo.mjs`, `check-code-workspace.mjs`, `check-conversation-feedback.mjs`) run against a dev server with mocked APIs; they are manual and write the screenshots in `docs/img`. Opt-in Docker runtime scripts are the `test:*:runtime` entries in `package.json`.

## Known limits

- The Windows agent has only syntax and C# compile checks. Wallpaper, kiosk placement, tray, hotkeys, audio devices and desktop control are not verified on real Windows.
- Voice quality, hands-free barge-in thresholds and phone calls (Asterisk with Linphone) are not verified with real microphones, speakers or SIP providers.
- No real model has been proven to choose the visualization tools unprompted; holographic cards and viewer are tested with fake data only.
- Memory lifecycle (kinds, supersede, ranking, consolidation) exists only for the Qdrant backend, and only against a fake Qdrant in tests.
- Data backups cover NOVA's own data folder; Qdrant, OmniRoute, Node-RED and Home Assistant volumes are excluded.
- Rolling back free-policy changes is disabled, because OmniRoute's key-permission endpoint has no compare-and-swap.
- No end-to-end suite for the web interface; open tasks are listed in the task file.
- Removed on purpose: 3D printing (fabrication, CAD worker, slicer, `/v1/fab/*` agent endpoints) and YouTube subtitles with their OAuth. Do not rebuild without a new request.

## Deployment status

Latest release tag: v0.1.66 (see [release notes](release-notes/)). Releases are tags; the Release workflow publishes the images and the Windows agent ([Releasing](releasing.md)). The production install lives outside this repository and is updated by changing `NOVA_VERSION` and running `docker compose pull && up -d`; the running version is reported by `GET /api/nova/health`. Nothing is pushed, tagged or deployed without explicit approval. The legacy `jarvis-agent.ps1` launcher and `JarvisAgent` scheduled task name stay for existing Windows installs.
