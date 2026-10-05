Upgrade the existing Jarvis project in `/opt/jarvis` from a mostly conversational responder into a persistent, action-capable home and infrastructure assistant.

Do NOT rewrite the application from scratch.

First inspect the entire existing project, architecture, configuration, Docker setup, current LLM implementation, OmniRoute implementation, tools/actions, API routes, frontend, persistence, existing Proxmox integration, and system prompt.

Preserve existing functionality unless replacing or refactoring it is clearly necessary.

The implementation must be modular, maintainable, testable, and production-oriented.

# Main objectives

Implement:

1. Qdrant long-term semantic memory
2. Proper short-term vs long-term memory architecture
3. Home Assistant integration as the primary smart-home control plane
4. Sonos control
5. Spotify/music playback support
6. Generic Jarvis tool/action architecture
7. Confirmation and safety controls
8. Action verification
9. Action audit logging
10. Better OmniRoute integration
11. Free-only cloud model routing
12. Automatic failover between free cloud providers
13. Provider/model health visibility
14. No paid model fallback
15. No local LLM/Ollama fallback
16. Better contextual follow-up understanding
17. Integration health/status endpoints
18. Graceful degradation when integrations are unavailable

Jarvis must evolve from:

User
→ LLM
→ text response

into:

User
→ Jarvis orchestrator
→ short-term context
→ long-term memory retrieval
→ entity/device resolution
→ LLM
→ structured tool call
→ policy validation
→ action execution
→ result verification
→ audit
→ response

# 1. Inspect existing architecture first

Before modifying anything, inspect:

- backend framework
- frontend framework
- database/storage
- existing services
- current conversation persistence
- existing LLM client
- current OmniRoute client/configuration
- `.env`
- `.env.example`
- Docker/Docker Compose
- API routes
- current system prompt
- current tool/command architecture
- Proxmox integration
- authentication/authorization
- logging
- frontend status/settings pages
- existing tests
- Playwright setup

Do not duplicate existing functionality.

Refactor existing working functionality into the new architecture where appropriate.

Provide a short summary of the existing architecture before making major changes.

# 2. Introduce a generic Jarvis tool/action architecture

Jarvis must stop treating every request as something that only produces text.

Create a generic structured tool system.

Conceptual tool definition:

Tool:

- name
- description
- input schema
- output schema
- risk level
- requires confirmation
- execute()
- verify()
- timeout
- enabled state

Example tools:

homeassistant.get_state
homeassistant.search_entities
homeassistant.call_service
homeassistant.turn_on
homeassistant.turn_off
homeassistant.toggle
homeassistant.set_brightness
homeassistant.set_temperature

media.get_state
media.play
media.pause
media.stop
media.next
media.previous
media.set_volume

sonos.group
sonos.ungroup
sonos.announce

spotify.search
spotify.play

proxmox.list_nodes
proxmox.list_vms
proxmox.get_vm
proxmox.start_vm
proxmox.stop_vm
proxmox.restart_vm

memory.search
memory.store
memory.delete

system.status

Use structured LLM tool/function calling where supported.

Do NOT:

- parse arbitrary generated natural-language commands
- use regex as the primary action engine
- let the LLM call arbitrary URLs
- let the LLM run arbitrary shell commands
- let the LLM fabricate tool results

# 3. Create a Jarvis orchestrator

Add a central orchestrator responsible for processing every request.

Conceptually:

async handleUserMessage(message):

    shortTermContext = contextService.load(...)
    memories = memoryService.search(message)
    relevantEntities = entityResolver.resolve(message)

    llmResult = llmClient.respond(
        message,
        shortTermContext,
        memories,
        relevantEntities,
        availableTools
    )

    while llmResult.hasToolCall():

        tool = toolRegistry.resolve(llmResult.tool)

        policy = actionPolicy.evaluate(
            tool,
            llmResult.arguments
        )

        if policy.requiresConfirmation:
            pendingActionService.save(...)
            return confirmationResponse

        result = tool.execute(...)

        verification = tool.verify(...)

        auditLog.save(...)

        llmResult = llmClient.continueWithToolResult(
            result,
            verification
        )

    return llmResult.text

Set a sane maximum number of tool iterations, e.g.:

JARVIS_MAX_TOOL_ITERATIONS=8

Prevent infinite or recursive tool loops.

# 4. Action risk levels

Implement risk levels in application code.

Suggested levels:

READ_ONLY
SAFE
CONFIRM
DANGEROUS

READ_ONLY examples:

- read sensor
- inspect light state
- check temperature
- inspect media state
- list VMs
- inspect VM status
- inspect integration health

SAFE examples:

- turn on one normal light
- pause music
- resume music
- reasonable volume change
- activate a known harmless scene

CONFIRM examples:

- restart VM
- shut down VM
- turn off many devices
- significant thermostat change
- group many speakers
- disruptive home-wide action

DANGEROUS examples:

- shutdown Proxmox node
- destructive storage operation
- delete VM
- remove automation
- remove large amounts of data
- destructive infrastructure action

Rules:

READ_ONLY:
execute immediately

SAFE:
execute automatically if configured

CONFIRM:
require explicit user confirmation

DANGEROUS:
always require explicit confirmation

The LLM must NEVER be able to override these rules.

# 5. Pending confirmations

Create a pending action system.

Store:

- action/tool
- arguments
- risk level
- requesting user/session
- created timestamp
- expiry
- confirmation status

Example conversation:

User:
Restart the Jellyfin VM.

Jarvis:
VM 105 is currently running. Restarting it will interrupt Jellyfin. Do you want me to restart it?

User:
Yes.

Jarvis should execute the exact stored pending action.

Do NOT ask the LLM to regenerate the action from memory after confirmation.

Pending actions must expire.

# 6. Home Assistant as the primary smart-home control plane

Use Home Assistant as Jarvis's abstraction layer for smart-home devices.

Preferred architecture:

Jarvis
→ Home Assistant
→ devices/services

Do NOT build separate vendor APIs when Home Assistant already exposes the device.

Add configuration such as:

HOME_ASSISTANT_ENABLED=true
HOME_ASSISTANT_URL=
HOME_ASSISTANT_TOKEN=

Use existing naming conventions if the project already has a configuration standard.

Create a reusable HomeAssistantClient.

Support:

- API connectivity test
- get state
- list/retrieve entities
- retrieve attributes
- call services
- turn on
- turn off
- toggle
- brightness
- color where supported
- climate temperature
- scenes
- scripts
- media player controls

Use Home Assistant REST and WebSocket APIs where appropriate.

# 7. Home Assistant entity registry

Jarvis must not let the LLM invent entity IDs.

Create an internal entity registry/catalog.

Store/cache:

- entity_id
- friendly_name
- domain
- area
- device name
- device ID if useful
- aliases
- capabilities
- supported features
- last synchronized
- last seen

Example:

entity_id:
light.woonkamer

friendly_name:
Woonkamer lamp

area:
Woonkamer

aliases:

- woonkamer licht
- living room light
- grote lamp

Synchronize periodically from Home Assistant.

Create an EntityResolver.

Resolution should consider:

- exact aliases
- friendly names
- area
- domain/type
- recent conversational context
- semantic matching where useful

Never execute an action against an uncertain entity without resolving ambiguity first.

# 8. Support contextual entity references

Jarvis should understand follow-ups.

Example:

User:
Turn the living room lights on.

User:
Make them 50%.

User:
Now turn them off.

All three commands should resolve to the same lights using short-term context.

Another example:

User:
Play music in the kitchen.

User:
Make it louder.

User:
Pause it.

All subsequent commands should resolve to the kitchen media player.

# 9. Sonos integration

Prefer Sonos through Home Assistant.

Do NOT build a separate Sonos API unless Home Assistant cannot provide a required capability.

Support:

- play
- pause
- stop
- next
- previous
- volume
- mute
- group
- ungroup
- favorites where exposed
- media playback
- announcements where supported

Examples Jarvis should understand:

"Play music in the living room."

"Pause the Sonos."

"Set kitchen volume to 25%."

"Group kitchen and living room."

"Ungroup the kitchen."

"What's playing downstairs?"

"Announce dinner is ready."

Actions must use real Home Assistant entities.

# 10. Spotify and music playback

Support Spotify/music commands through Home Assistant.

Preferred hierarchy:

Jarvis
→ Home Assistant
→ Music Assistant
→ Sonos / Spotify

Fallback where appropriate:

Jarvis
→ Home Assistant
→ media_player / Sonos
→ media URI

Do not require Music Assistant for Jarvis startup.

Detect whether Music Assistant is available.

Add:

MUSIC_ASSISTANT_ENABLED=true

or equivalent existing configuration style.

Jarvis should support:

"Play Rammstein in the living room."

"Play Discover Weekly."

"Play relaxing music downstairs."

"Play Spotify in the kitchen."

"Play the same thing upstairs."

"Pause everything downstairs."

Resolve:

intent
→ search/query
→ media
→ target player/room
→ playback action

Do not let the LLM construct arbitrary Home Assistant REST requests.

# 11. Proxmox integration through the same tool architecture

Preserve the existing Proxmox integration.

Refactor it into the generic tool system if necessary.

Support at least:

- list nodes
- list VMs
- list containers
- status
- CPU
- memory
- uptime
- start
- stop
- shutdown
- restart

Use the existing working Proxmox API/authentication implementation.

Do not replace working authentication unnecessarily.

Read actions should be READ_ONLY.

Start may be SAFE or CONFIRM depending on existing configuration.

Restart/stop/shutdown should normally require confirmation.

Destructive actions should always require confirmation.

# 12. Qdrant long-term memory

Add Qdrant as Jarvis's semantic long-term memory system.

Do NOT use Qdrant for short-term conversational state.

If Docker Compose is already used, add Qdrant.

Example concept:

qdrant:
image: qdrant/qdrant
restart: unless-stopped
volumes: - qdrant_data:/qdrant/storage

Add:

QDRANT_ENABLED=true
QDRANT_URL=http://qdrant:6333
QDRANT_COLLECTION=jarvis_memory

Use project naming conventions where appropriate.

Create a MemoryService abstraction so the application is not tightly coupled to raw Qdrant calls everywhere.

# 13. Memory types

Support structured metadata around semantic memories.

Suggested memory types:

USER_FACT
PREFERENCE
DEVICE_CONTEXT
HOME_CONTEXT
INFRASTRUCTURE
CONVERSATION_SUMMARY
PROCEDURE
ACTION_RESULT
LEARNED_ALIAS

Example memories:

"The office Sonos is normally called 'computer speaker'."

"The living room is normally set to 21 C."

"VM 105 hosts Jellyfin."

"The main Proxmox node is normally called the main server."

"Movie mode dims the living-room lights and uses the living-room Sonos."

Only store useful durable information.

Do NOT store every user message.

# 14. Memory metadata

Each long-term memory should support metadata such as:

id
type
text
source
created_at
updated_at
importance
confidence
last_accessed_at
access_count
tags
related_entity
related_area
related_device

Use Qdrant payload metadata.

# 15. Memory write pipeline

Implement:

conversation/event
→ detect memory candidate
→ classify
→ normalize
→ check whether durable/useful
→ deduplicate
→ embed
→ store in Qdrant

Do not automatically store:

- greetings
- temporary requests
- random one-off values
- transient state
- intermediate reasoning
- passwords
- tokens
- API keys
- secrets
- raw authentication data

# 16. Memory retrieval

Before calling the LLM:

user request
→ generate/reuse embedding
→ search relevant memories
→ score/rank
→ filter
→ inject only useful memories

Do not dump the entire memory database into model context.

Use:

- similarity
- memory type
- relevance
- importance
- recency
- entity context

Limit retrieved memories.

# 17. Memory deduplication

Implement semantic deduplication.

Avoid examples such as:

"The living room is 21 degrees."

"Living-room preferred temperature is 21."

"Preferred temp in living room: 21 C."

being stored as three independent facts.

Merge or update memories when appropriate.

# 18. Memory maintenance

Add maintenance functionality:

- inspect memories
- search memories
- delete memories
- update memories
- merge duplicates
- reduce stale low-value memories
- update contradicted facts
- track usage

Provide API endpoints such as:

GET /api/memory
GET /api/memory/search
DELETE /api/memory/{id}

Adapt routes to the existing API style.

If an admin/settings UI exists, add a Memory view.

Show:

- memory
- type
- importance
- source
- created
- updated
- last used
- delete/edit where appropriate

# 19. Short-term memory

Keep short-term memory separate from Qdrant.

Use existing DB/session storage or Redis if Redis already exists.

Short-term context should include:

- recent messages
- active task
- most recently referenced room
- most recently referenced entity/device
- media target
- pending action
- recent tool results
- unresolved ambiguity

Example:

User:
Play music in the living room.

User:
Make it louder.

"Louder" should use active short-term context.

Do not persist that as a permanent Qdrant memory.

# 20. Embeddings

Inspect the current model/provider architecture and choose an embedding strategy that does NOT require running a local AI model.

Requirements:

- no Ollama
- no local LLM
- no local embedding model
- no GPU-dependent local inference

Use a free remote embedding provider if available through the configured ecosystem.

If no reliable free embedding endpoint is available, design MemoryService so the embedding provider is pluggable and document what remains required.

Do not silently introduce paid embedding usage.

Respect the same no-cost requirement as the LLM routing.

# 21. OmniRoute architecture

Jarvis must use OmniRoute as the single LLM gateway.

Preferred:

Jarvis
→ OmniRoute
→ free cloud providers

Do NOT:

- call OpenAI directly
- call Anthropic directly
- call Gemini directly from Jarvis
- build another full provider router inside Jarvis
- use Ollama
- use any local LLM

Jarvis should view OmniRoute as an OpenAI-compatible API endpoint where possible.

# 22. Fix OMNIROUTE_MODEL

The current configuration contains:

OMNIROUTE_MODEL=1

Inspect exactly how the current application interprets this.

If it is passed as the requested OmniRoute model/route, replace it with OmniRoute's supported automatic route, likely:

OMNIROUTE_MODEL=auto

but verify against the currently installed OmniRoute version.

Do not blindly assume configuration keys or route IDs.

Use the installed OmniRoute version as the source of truth.

# 23. OmniRoute free-only mode

Jarvis must use ONLY genuinely free cloud models/providers.

Absolute rules:

- no paid OpenAI API
- no paid Anthropic API
- no paid Gemini usage
- no paid OpenRouter model
- no fallback that may generate charges
- no local Ollama/local AI model
- no trial-only provider as a normal fallback
- no provider requiring billing as the default route

Add a configuration policy such as:

JARVIS_LLM_FREE_ONLY=true

If OmniRoute itself supports an equivalent native free-only restriction, prefer using that.

Do not duplicate native OmniRoute functionality unnecessarily.

# 24. Free provider classification

When configuring providers, distinguish:

FREE_RECURRING
FREE_KEYLESS
TRIAL_ONLY
PAID
UNKNOWN

Only:

FREE_RECURRING
FREE_KEYLESS

should be enabled by default.

Do not treat these as sustainable free providers:

- $5 signup credit
- temporary promotional credits
- one-month trial
- introductory balance
- "free until credits run out"

Exclude those from the default routing pool.

# 25. Discover supported free providers dynamically

Inspect the installed OmniRoute version and its provider/model catalog.

Determine which providers are currently supported.

Potential candidates may include providers such as:

- Gemini free tier
- Groq free tier
- Mistral free tier
- Cloudflare Workers AI free allocation
- OpenRouter models explicitly marked `:free`
- other verified free/keyless providers supported by the installed OmniRoute version

Do NOT blindly enable these names.

Verify:

- provider exists
- provider configuration is supported
- provider is still free
- quota is recurring rather than trial-only
- account/billing requirements
- exact provider/model identifiers

Document the findings.

# 26. No local AI fallback

This is a strict requirement.

Do NOT install, configure, or use:

- Ollama
- llama.cpp
- LocalAI
- vLLM
- LM Studio
- local embedding models
- local language models
- downloaded model weights
- GPU inference
- CPU inference for LLMs

Jarvis should not host AI models locally.

If all free cloud models are unavailable, Jarvis should return a clear service unavailable message.

Example:

"All configured free AI providers are currently unavailable or rate-limited. Please try again later."

Do not fall back to a paid provider.

# 27. OmniRoute failover behavior

The intended behavior is:

Jarvis
↓
OmniRoute
↓
Free Provider A
↓
429 / quota / unavailable
↓
cooldown
↓
Free Provider B
↓
429 / unavailable
↓
Free Provider C
↓
...
↓
all free providers unavailable
↓
return unavailable error

Do NOT:

- route to paid model
- route to local model
- bypass OmniRoute

# 28. Use OmniRoute's native resilience

Inspect and use OmniRoute's built-in resilience features where supported:

- rate-limit detection
- 429 handling
- Retry-After
- per-account cooldowns
- connection health
- circuit breakers
- provider health
- model lockouts
- retries
- fallback routing

Do not build a competing provider failover implementation inside Jarvis.

Jarvis should retry OmniRoute only where safe and necessary.

# 29. Free-only allowlist

Create or document an explicit free model/provider allowlist if OmniRoute does not provide native cost filtering.

The system should reject:

- paid models
- models with unknown pricing status
- non-`:free` OpenRouter models
- trial-only routes if FREE_ONLY is enabled

Add audit/logging around rejected routes.

Example:

Rejected route:
provider=openrouter
model=some-paid-model
reason=FREE_ONLY_POLICY

# 30. OpenRouter safety

If OpenRouter is configured, allow only models explicitly identified as free.

Prefer model identifiers containing the provider's actual free designation, such as `:free`, if that is how the installed integration identifies them.

Never silently switch:

model:free
→ paid version

If cost status cannot be verified, reject it when:

JARVIS_LLM_FREE_ONLY=true

# 31. OmniRoute provider setup

Prepare/document multiple free cloud providers.

Do not commit credentials.

Keep credentials in environment/configuration appropriate to OmniRoute.

If OmniRoute owns provider credentials, do not duplicate those credentials inside Jarvis.

Document for each selected provider:

- provider name
- authentication method
- API key required?
- OAuth required?
- free recurring quota?
- payment method required?
- supported models
- known rate limits
- role in routing order

# 32. OmniRoute provider priority

Prefer high-quality free providers first.

A conceptual priority could be:

Tier 1:
high-quality recurring free providers

Tier 2:
fast free providers

Tier 3:
keyless/free backup providers

Do not hardcode a guessed order before inspecting OmniRoute's current capabilities.

Allow OmniRoute to make health/rate-limit-based decisions.

Quality, availability, latency, and free status should determine routing.

# 33. No-cost guarantee

The architecture should make accidental paid use difficult.

When:

JARVIS_LLM_FREE_ONLY=true

then:

- reject known paid routes
- reject unknown-cost routes
- reject trial-only routes unless explicitly whitelisted
- never use a paid fallback
- never use a local LLM
- never automatically switch billing modes

If all allowed providers fail:

fail safely.

# 34. OmniRoute observability

Capture routing metadata if OmniRoute exposes it.

Potential fields:

- selected provider
- selected model
- latency
- retry count
- fallback occurred
- cooldown reason
- rate-limit event
- request status

Do not invent metadata.

Expose only what OmniRoute actually returns.

Never log:

- API keys
- bearer tokens
- OAuth secrets

# 35. Free-provider status UI

If Jarvis has or gains an admin/status page, show something like:

AI Routing

OmniRoute:
Connected

Mode:
Free cloud only

Local AI:
Disabled

Paid fallback:
Disabled

Available:
✓ Provider A
✓ Provider B
✓ Provider C

Cooldown:
⏳ Provider D

Unavailable:
✕ Provider E

Last request:
Provider: ...
Model: ...
Latency: ...
Fallbacks: ...

Only display verified information.

# 36. Home Assistant action verification

After issuing a Home Assistant command, verify the resulting state when practical.

Example:

Tool execution:

turn_on light.woonkamer

Then query:

light.woonkamer state

Only say:

"The living-room light is on."

if Home Assistant confirms it.

Otherwise say:

"I sent the command, but Home Assistant still reports the light as off."

Apply verification to:

- lights
- switches
- climate
- volume
- playback where possible
- Proxmox VM power state

# 37. Never hallucinate actions

Add strict system/tooling rules:

Jarvis must never claim an action succeeded unless a tool executed successfully.

Never say:

"Done."

when only text was generated.

Correct flow:

user command
→ tool call
→ execution
→ result
→ verification
→ response

If execution fails, say it failed.

If verification is uncertain, say so.

Never invent:

- entity IDs
- VM IDs
- API results
- service calls
- device state

# 38. Action audit log

Add an audit trail.

Store:

timestamp
user/session
tool
arguments with secrets redacted
risk level
confirmation required
confirmed
result
success/failure
verification result
duration

Examples:

2026-10-04 12:10
homeassistant.turn_on
light.woonkamer
SAFE
success

2026-10-04 12:15
proxmox.restart_vm
vm=105
CONFIRM
confirmed
success

Add an admin/API view if appropriate.

# 39. Integration health service

Add or expand:

GET /api/health

Return structured health status.

Example:

{
"jarvis": {
"status": "ok"
},
"omniroute": {
"status": "ok",
"mode": "free_only"
},
"qdrant": {
"status": "ok"
},
"homeAssistant": {
"status": "ok"
},
"proxmox": {
"status": "ok"
}
}

Do not expose secrets.

A failure in Qdrant or Home Assistant should not necessarily crash Jarvis.

# 40. Graceful degradation

Home Assistant unavailable:

Jarvis should still answer conversational requests.

For action requests:

"I can't reach Home Assistant right now, so I wasn't able to turn the light on."

Qdrant unavailable:

continue without long-term memory.

Proxmox unavailable:

report the integration error.

OmniRoute unavailable:

Jarvis cannot perform AI processing.

All free OmniRoute providers exhausted:

return a clear rate-limit/unavailable message.

Do not use paid or local AI fallback.

# 41. Configuration

Update `.env.example`.

Conceptually:

# OmniRoute

OMNIROUTE_ENABLED=true
OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
OMNIROUTE_API_KEY=
OMNIROUTE_MODEL=auto
JARVIS_LLM_FREE_ONLY=true

# Qdrant

QDRANT_ENABLED=true
QDRANT_URL=http://qdrant:6333
QDRANT_COLLECTION=jarvis_memory

# Home Assistant

HOME_ASSISTANT_ENABLED=true
HOME_ASSISTANT_URL=
HOME_ASSISTANT_TOKEN=

# Music

MUSIC_ASSISTANT_ENABLED=true

# Actions

JARVIS_SAFE_ACTIONS_AUTO_EXECUTE=true
JARVIS_CONFIRM_DANGEROUS_ACTIONS=true
JARVIS_MAX_TOOL_ITERATIONS=8

Use current application naming conventions.

Do not create duplicate configuration systems.

# 42. Docker

If Docker Compose is already used, add Qdrant cleanly.

Concept:

services:
qdrant:
image: qdrant/qdrant
restart: unless-stopped
volumes: - qdrant_data:/qdrant/storage

Do not add:

- Ollama
- local model containers
- GPU containers
- local embedding servers

Home Assistant and OmniRoute can remain external services if that matches the existing deployment.

# 43. Backend structure

Prefer modular components such as:

services/
llm/
OmniRouteClient
LlmService

memory/
MemoryService
QdrantMemoryStore
EmbeddingProvider
MemoryClassifier
MemoryDeduplicator

tools/
ToolRegistry
ToolExecutor
ActionPolicy
PendingActionService

integrations/
homeassistant/
proxmox/

context/
ConversationContextService
EntityContextService

audit/
ActionAuditService

Adapt to the application's current language/framework conventions.

# 44. Tests

Add unit/integration tests for:

Home Assistant:

- connectivity
- state retrieval
- service calls
- entity resolution
- failed execution
- verification

Tool system:

- registration
- validation
- unknown tool
- SAFE action
- CONFIRM action
- DANGEROUS action
- pending confirmation
- rejected confirmation
- expired confirmation

Context:

- "turn it down"
- "pause it"
- "turn them off"
- multi-turn entity references

Memory:

- write
- retrieve
- metadata
- deduplication
- disabled Qdrant
- unavailable Qdrant
- memory selection

Proxmox:

- read-only status
- start
- restart confirmation
- verification

OmniRoute:

- successful request
- provider rate limited
- provider unavailable
- automatic fallback
- all free providers unavailable
- paid route rejected
- unknown-cost route rejected
- trial-only route rejected
- OpenRouter free route allowed
- paid OpenRouter route rejected
- no local fallback
- no paid fallback

Use mocks.

Do not intentionally exhaust real provider quotas.

Do not operate real home devices in automated tests.

# 45. Playwright tests

Playwright is available/being added.

If Jarvis has a web UI, add end-to-end tests for:

- chat loads
- send normal question
- read-only tool result
- safe action display
- confirmation dialog/message
- approve action
- reject action
- failed integration message
- integration status
- memory page
- audit page if implemented
- OmniRoute free-only status
- all providers unavailable response

Use mocked/test integrations.

Do not control real devices from automated Playwright tests.

# 46. Logging

Add structured logging where useful.

Include:

- integration
- tool
- action
- provider
- model
- duration
- result
- error type

Redact:

- tokens
- API keys
- authorization headers
- passwords
- Home Assistant token
- Proxmox secret
- OmniRoute secrets

# 47. System prompt changes

Update the Jarvis system instructions.

Important rules:

- Use tools for real-world actions.
- Never claim an action happened without a successful tool response.
- Never invent device IDs.
- Never invent Home Assistant entities.
- Never invent VM IDs.
- Resolve ambiguity before acting.
- Use short-term context for follow-up references.
- Retrieve useful long-term memories when relevant.
- Do not expose secrets.
- Respect confirmation rules.
- Never choose a paid model.
- Never use a local LLM.
- If all free models are unavailable, report that clearly.

# 48. Natural-language examples

Jarvis should eventually support:

"Turn the living room lights off."

"Set the living room to 21 degrees."

"What's the temperature downstairs?"

"Start movie mode."

"Play Rammstein in the living room."

"Turn it down."

"Pause it."

"What's playing?"

"Group kitchen with living room."

"Turn everything downstairs off."

"Is Jellyfin running?"

"Start VM 105."

"Restart the Jellyfin VM."

"Which VMs are using the most RAM?"

"Remember that I call the office Sonos the computer speaker."

"What's the Proxmox CPU usage?"

"Are any integrations offline?"

# 49. Desired final architecture

Target architecture:

                         Free Provider A
                        /
                       Free Provider B
                      /

User → Jarvis → OmniRoute → Free Provider C
│  
│ Free Provider D
│
├── Short-term context
│
├── Qdrant
│ └── long-term semantic memory
│
├── Tool system
│ │
│ ├── Home Assistant
│ │ ├── lights
│ │ ├── switches
│ │ ├── climate
│ │ ├── scenes
│ │ ├── sensors
│ │ ├── Sonos
│ │ ├── Spotify
│ │ └── Music Assistant
│ │
│ └── Proxmox
│
└── Audit / confirmation / verification

There must be:

NO paid model fallback.

NO local LLM.

NO Ollama.

NO local embeddings.

# 50. Implementation phases

Implement incrementally.

Phase 1:

- inspect architecture
- refactor LLM layer
- fix OmniRoute model/configuration
- establish free-only policy
- inspect supported free providers

Phase 2:

- tool registry
- action policy
- confirmation system
- audit log

Phase 3:

- Home Assistant integration
- entity registry
- entity resolver
- basic actions

Phase 4:

- Sonos
- Spotify
- Music Assistant

Phase 5:

- Qdrant
- embedding provider abstraction
- long-term memory
- deduplication

Phase 6:

- contextual references
- action verification
- improved orchestration

Phase 7:

- UI/status pages
- integration health
- OmniRoute/provider visibility

Phase 8:

- unit tests
- integration tests
- Playwright tests
- documentation

Do not break currently working chat or Proxmox functionality during migration.

# 51. Important implementation rules

Do not:

- rewrite Jarvis from scratch
- remove working features without reason
- add arbitrary shell-command execution
- let the LLM issue raw HTTP requests
- let the LLM bypass action policies
- hardcode secrets
- commit API keys
- invent entity IDs
- invent model/provider metadata
- install Ollama
- install local models
- use local embeddings
- fall back to paid AI
- use trial credit as a permanent free provider
- claim actions succeeded without verification

# 52. Final deliverables

When the implementation is complete, provide:

1. Existing architecture summary
2. New architecture summary
3. Files added
4. Files modified
5. Database/schema changes
6. Docker changes
7. Qdrant configuration
8. Memory architecture
9. Embedding provider used
10. Home Assistant configuration
11. Home Assistant token setup instructions
12. Sonos setup
13. Spotify setup
14. Music Assistant setup
15. Proxmox changes
16. Tool architecture
17. Risk/confirmation rules
18. Action verification behavior
19. Audit logging behavior
20. OmniRoute configuration
21. Previous value/meaning of `OMNIROUTE_MODEL=1`
22. New OmniRoute model configuration
23. Free providers supported by the installed OmniRoute version
24. Which providers were enabled
25. Which require API keys
26. Which require OAuth
27. Which are keyless
28. Which are recurring free
29. Which were excluded because they are trial-only
30. Which were excluded because they are paid
31. Exact free models enabled
32. Routing/failover behavior
33. How FREE_ONLY is enforced
34. Proof/documentation that there is no paid fallback
35. Confirmation that there is no Ollama/local AI
36. Integration health endpoint
37. New environment variables
38. Commands to install dependencies
39. Commands to run migrations
40. Commands to run tests
41. Commands to run Playwright
42. Commands to start/restart Jarvis
43. Example commands Jarvis can now execute
44. Remaining limitations/TODOs

Run:

- unit tests
- integration tests
- formatter/linter
- type checks
- backend tests
- frontend tests
- Playwright tests

before considering the task complete.

The end result must be a working first version, not only interfaces, stubs, placeholder classes, or TODO comments.
