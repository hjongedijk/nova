# Native OmniRoute integration

Verified against the installed OmniRoute 3.8.51 on 4 October 2026. Its shipped OpenAPI specification and framework guides were checked against live authenticated responses; several memory response shapes differ from the specification.

| Feature                                | NOVA integration                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud routing and resilience           | Native `auto` route, restricted confirmed free accounts, native model selection, retries and cooldowns. NOVA still checks policy before inference.                                                                             |
| Durable memory                         | Native SQLite storage, scoped to the existing NOVA API key and entries tagged `application=jarvis`. Native text search, with bounded recent recall when no keyword matches. No embedding model required.                       |
| Procedural memory                      | NOVA `PROCEDURE` entries use native `procedural` memory type; existing durable-intent and secret checks still apply.                                                                                                           |
| Agent Skills                           | Live 46-entry documentation catalog and individual SKILL.md documents through `omniroute_agent_skills`. Documentation does not grant execution permissions.                                                                    |
| Gateway inspection                     | Read-only `omniroute_status` tool and an OmniRoute tab in Status & Memory. Management credentials and cookies never appear in these responses.                                                                                 |
| Compression                            | Native lite mode selected with `x-omniroute-compression`. Global default and auto-trigger stay off. System prompts and structured tool results remain protected. A real streamed reply returned `lite; source=request-header`. |
| Session affinity and usage attribution | Both documented session headers carry the NOVA session ID. Returned compression, cache and session metadata join the existing routing metadata.                                                                                |
| Response cache                         | Native statistics are displayed. Tool-capable requests send `x-omniroute-no-cache=true` to prevent replay of cached actions or stale device readings.                                                                          |
| Qdrant                                 | Existing bind mount and data are preserved. Native Qdrant address is prepared with a separate `omniroute_memory` collection name; vectors remain disabled until a free embedding endpoint is verified.                         |
| Executable Omni Skills                 | Automatic interception stays off. NOVA retains tool validation, risk classification, explicit confirmations and audit. Shell, file writes and unreviewed marketplace skills are not automatically exposed.                     |
| MCP / A2A                              | Alternative gateway protocols are present; NOVA already uses authenticated REST and SSE. No additional autonomous agent or duplicate router was introduced.                                                                    |

## Configuration

```dotenv
OMNIROUTE_ADMIN_PASSWORD=<existing dashboard password>
JARVIS_MEMORY_BACKEND=omniroute
JARVIS_OMNIROUTE_COMPRESSION=lite
```

The password belongs only in `.env`. Compose passes it to the NOVA API, not the browser or Node-RED. Node-RED now receives only its Proxmox configuration, tool authentication secret and timezone. The backend obtains a private HttpOnly management session, reauthenticates once after expiry and uses fixed endpoints. Models have no generic management API proxy or settings-writing tool.

Native automatic memory extraction and native skill interception remain disabled. NOVA explicitly writes durable facts, retrieves owned memories, and injects them as untrusted context. Every chat request also opts out of native automatic injection, preventing duplicated context and automatic retention of transient assistant claims. Existing short-term conversation JSON remains in place.

Native keyword storage works while vectors and embeddings are unavailable. Local static and transformer embeddings, reranking and unverified remote embedding calls remain disabled. Qdrant is a running storage service, not a prerequisite for keyword memory.

To reapply the reviewed native settings on this Docker host:

```bash
cd /opt/jarvis
python3 scripts/configure-native-features.py
docker compose up -d --build --no-deps jarvis-api node-red
```

The configuration script backs up the native database privately before changing settings. It does not alter provider credentials, inference keys or stored memories. To disable the integration without deleting data, set `JARVIS_MEMORY_BACKEND=qdrant` and `JARVIS_OMNIROUTE_COMPRESSION=off`, then recreate the API. Native memories remain stored in OmniRoute; the legacy Qdrant backend still requires a configured embedding model. Restore individual native settings through the management API rather than replacing a live database containing newer memories.

## Validation

34 backend/Node-RED tests, lint, type checking, formatting and syntax checks pass. Ten fixture Chromium scenarios and desktop/mobile live Chromium checks pass. Live verification covered native memory creation, keyword retrieval, confirmation-backed deletion, skill-document reads, a model call to `omniroute_status`, session metadata and the applied compression header. Temporary test memories and conversation sessions were removed. Original provider credential fields and inference-key values were compared against the private backup and preserved.

Evidence and screenshots: `artifacts/playwright-native-omniroute/report.json`, `artifacts/playwright-extensions/report.json`.
