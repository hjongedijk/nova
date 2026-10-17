# NOVA documentation

| Document                                            | For                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)               | Step-by-step production install with Docker, first run, HTTPS, data, updates, troubleshooting   |
| [Configuration](configuration.md)                   | Every environment variable (default, meaning, secret), the data folder, the Settings screen     |
| [Tools and safety](tools-and-safety.md)             | Tool sources, risk levels, confirmation flow, audit log, secret masking, network guard          |
| [OmniRoute and free routing](omniroute.md)          | How model access works, the fail-closed free-route check and its policy file                    |
| [Windows agent](windows-agent.md)                   | Installing and configuring the PC agent: wallpaper, helper overlay, browser                     |
| [NOVA Desk](nova-desk.md)                           | Native Windows app (Rust/Tauri) for the helper and the living wallpaper; install, login, status |
| [Architecture](architecture.md)                     | Components, module map, bridges, request flow, web app                                          |
| [Development](development.md)                       | Running locally, commands, tests, adding a tool, editor setup                                   |
| [Releasing](releasing.md)                           | Version numbers and how a tag publishes the image and agent                                     |
| [Private notes](notes.md)                           | Explicit note capture, local storage, search and deletion                                       |
| [Document library](document-library.md)             | Explicit file indexing and private Qdrant search                                                |
| [Image understanding](image-understanding.md)       | Photo uploads, free vision routing and privacy                                                  |
| [Planning lists](planning-lists.md)                 | Local lists and synchronized Home Assistant to-do entities                                      |
| [Cooking mode](cooking-mode.md)                     | Read recipe steps aloud, voice step controls, and planner timers                                |
| [Music and media](media-control.md)                 | Home Assistant and Music Assistant playback, volume, and confirmation rules                     |
| [Web research](research.md)                         | Multi-step source research, citations, and uncertainty                                          |
| [Node-RED packages](node-red-palette.md)            | Approved packages, exact versions, confirmation and inventory verification                      |
| [Node-RED logboek](node-red-logs.md)                | On-demand bounded log snapshots, secret redaction and current-flow links                        |
| [Node-RED routines](node-red-routines.md)           | Personal daily reminder routines and their safety boundaries                                    |
| [Routes and travel time](routes.md)                 | Optional free route source, setup, attribution and current limits                               |
| [Holografische visualisatie](holographic-engine.md) | Herbruikbare 3D/2D-viewer, providers, tools en componentAPI                                     |
| [Local plugins](local-plugins.md)                   | Private JSON webhook manifests, limits and safety rules                                         |
| [Conversation language](conversation-language.md)   | Switch one conversation between Dutch and English, including voice                              |
| [Conversation milestone](conversation-milestone.md) | Opt-in completed-turn counter, quiet delivery, restart recovery and privacy                     |
| [Kleine verrassingen](small-surprises.md)           | Opt-in birthdays from explicit memory, public occasions and delivery guards                     |
| [Dagelijks hoogtepunt](daily-highlight.md)          | Positive statements, verified daily actions, local scheduling and restart-safe delivery         |
| [Conversation handoff](conversation-handoff.md)     | Save a small local handoff card and resume a conversation later                                 |
| [Urgent phone notifications](push-notifications.md) | Private ntfy setup and what NOVA sends to the phone                                             |

## More topic pages

Reference pages that are not listed above.

| Page                                                                      | File                             |
| ------------------------------------------------------------------------- | -------------------------------- |
| [CalDAV calendar](caldav-calendar.md)                                     | `caldav-calendar.md`             |
| [HTTPS certificate monitoring](certificate-monitoring.md)                 | `certificate-monitoring.md`      |
| [Code-role evaluation set](code-evaluation.md)                            | `code-evaluation.md`             |
| [Compose notification integration test](compose-notification-test.md)     | `compose-notification-test.md`   |
| [Container and NOVA release alerts](container-monitoring.md)              | `container-monitoring.md`        |
| [Real conversations (phone and voice)](conversations.md)                  | `conversations.md`               |
| [Scheduled data backups](data-backups.md)                                 | `data-backups.md`                |
| [Bureaublad zien en bedienen (API-contract)](desktop-control-api.md)      | `desktop-control-api.md`         |
| [Desktop view and control (Windows agent)](desktop-control.md)            | `desktop-control.md`             |
| [Current state](development-state.md)                                     | `development-state.md`           |
| [Energy monitoring](energy-monitoring.md)                                 | `energy-monitoring.md`           |
| [Helper design and validation](helper-design.md)                          | `helper-design.md`               |
| [Household profiles](household-profiles.md)                               | `household-profiles.md`          |
| [Long-term memory](long-term-memory.md)                                   | `long-term-memory.md`            |
| [MCP server selection policy](mcp-server-policy.md)                       | `mcp-server-policy.md`           |
| [Memory model (lifecycle)](memory.md)                                     | `memory.md`                      |
| [Network and device monitoring](network-monitoring.md)                    | `network-monitoring.md`          |
| [Checklist voor een nieuwe tool](new-tool-checklist.md)                   | `new-tool-checklist.md`          |
| [News and RSS](news-feeds.md)                                             | `news-feeds.md`                  |
| [`node-red-contrib-nova`](node-red-contrib-nova.md)                       | `node-red-contrib-nova.md`       |
| [Embedded Node-RED editor](node-red-editor.md)                            | `node-red-editor.md`             |
| [Node-RED flows in NOVA](node-red-flows.md)                               | `node-red-flows.md`              |
| [Node-RED health heartbeat](node-red-health-heartbeat.md)                 | `node-red-health-heartbeat.md`   |
| [Node-RED, MQTT and HTTP boundaries](node-red-mqtt.md)                    | `node-red-mqtt.md`               |
| [Doelen om in de gaten te houden (standing objectives)](objectives.md)    | `objectives.md`                  |
| [OmniRoute administration API: verified baseline](omniroute-admin-api.md) | `omniroute-admin-api.md`         |
| [Persona evaluation set](persona-evaluation.md)                           | `persona-evaluation.md`          |
| [Optional local Piper voice](piper-jarvis-voice.md)                       | `piper-jarvis-voice.md`          |
| [Proactive speech policy](proactive-speech.md)                            | `proactive-speech.md`            |
| [Settings workspace](settings-design.md)                                  | `settings-design.md`             |
| [Settings inventory](settings-inventory.md)                               | `settings-inventory.md`          |
| [Settings service inventory](settings-services-inventory.md)              | `settings-services-inventory.md` |
| [Presence-aware unsolicited speech](speech-presence.md)                   | `speech-presence.md`             |
| [Telefonie: Asterisk en Linphone](telephony.md)                           | `telephony.md`                   |
| [Timer recovery](timer-recovery.md)                                       | `timer-recovery.md`              |
| [Weekly overview](weekly-overview.md)                                     | `weekly-overview.md`             |

Back to the [README](../README.md).
