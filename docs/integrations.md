# Integrations

Everything NOVA talks to besides its tools' own logic: language models, smart-home and server services, calendars, automation, phones and extra tool providers. Integrations stay off until configured; **Instellingen → Koppelingen** and `GET /api/integrations` show what is connected. All variables are listed in [Configuration](configuration.md). Every tool an integration adds is subject to [Tools and safety](tools-and-safety.md).

| Integration                                      | Section                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language models (OmniRoute, free routing)        | [Language models](#language-models-omniroute)                                                                                                                  |
| Home Assistant, Proxmox, Termix, Pangolin        | [Home Assistant](#home-assistant), [Proxmox, Termix, Pangolin](#proxmox-termix-pangolin)                                                                       |
| CalDAV calendar, news, routes, ntfy, Piper voice | [Calendar](#calendar-caldav), [News](#news), [Routes](#routes-and-travel-time), [ntfy](#urgent-phone-notifications-ntfy), [Piper](#optional-local-piper-voice) |
| Node-RED and MQTT                                | [Node-RED and MQTT](#node-red-and-mqtt)                                                                                                                        |
| MCP servers                                      | [MCP servers](#mcp-servers)                                                                                                                                    |
| Your own HTTP APIs                               | [Your own HTTP APIs](#your-own-http-apis)                                                                                                                      |
| Phone calls, spoken conversations, Linphone      | [Telephony and conversations](#telephony-and-conversations)                                                                                                    |
| Windows PC                                       | [Windows agent](windows-agent.md)                                                                                                                              |

## Language models (OmniRoute)

NOVA never calls a model provider directly. Every language-model request goes to [OmniRoute](https://github.com/diegosouzapw/OmniRoute), a self-hosted gateway that holds your provider accounts, picks a model (`auto`), tracks quota and fails over. NOVA adds one rule on top: **it only sends a request when it has verified that the route is free**, and otherwise it refuses to talk to any model. There is no paid, local or alternative-gateway fallback.

The compose stack pins the OmniRoute image by digest and sets `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=false`.

### What NOVA checks before every request

`apps/api/src/routing/routing.service.ts` runs on every chat request (and for the settings assistant). It reads two things:

1. **The policy file** `free-routing-policy.json` in NOVA's data folder.
2. **OmniRoute's own database**, opened read-only (`OMNIROUTE_DATABASE`, mounted into the container from `omniroute-data/storage.sqlite`).

The route is "ready" only when all of these hold:

- OmniRoute's setting `freeAccessPolicy` matches the policy (`nativeFreeAccessPolicy`, default `strict`), `hidePaidModels` and `excludeTosAvoid` are `true`, and, if the policy lists a `nativeModelAllowlist`, OmniRoute's `modelVisibilityAllowlist` is exactly that list.
- `OMNIROUTE_MODEL` is `auto` and equals the policy's `route`.
- The API key in `OMNIROUTE_API_KEY` is active, in `restricted` mode, must allow `auto` and may additionally allow only enabled models from the same attested free pool, and is limited to a non-empty set of connections that are all listed as verified in the policy (`verifiedConnectionIds`, or `verifiedProviders` when that is absent). Explicit model grants also require credential-bound accounts, an exact native model allowlist, account-free attestation and current free-access eligibility. Existing auto-only keys remain supported for automatic routing. Explicit-model dispatch and the role picker use only the actual model grants on that key; a verified free catalog entry alone does not grant access. Each connection must still exist, be active and belong to a verified provider in the native database. Wizard-generated policies also bind each account to its provider, authentication type and credential fingerprint. Any observed credential change blocks the route; credentials and fingerprints stay outside public status and audit output.
- Every provider in the policy's `blockedProviders` is also blocked in OmniRoute.
- The policy has at least one enabled model, and every enabled model is a catalog entry that is `nativeAutoEligible` and passes the free-access classification below.

Management changes also block inference while `free-routing-management-block.json` exists. A failed or partial account operation retains that stop until fresh verification succeeds; restarting does not clear it. Compound filesystem failures retain an in-memory stop as well.

Anything else, including a missing or unreadable policy file or database, blocks inference. The status is visible in the interface and at `GET /api/providers` (fields such as `ready`, `status`, `reason`), with the values `POLICY_DRIFT_BLOCKED` and `POLICY_UNAVAILABLE` for the failure cases.

#### Free-access classification

A catalog entry in the policy is allowed only when `classifyFreeAccess` (in `routing/free-access.ts`) says so:

| Case                                                                                                         | Result                                                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Terms (`tos`) are `avoid`, `ambiguous` or `unknown`                                                          | denied                                                                     |
| Local model                                                                                                  | denied (no local fallback)                                                 |
| Promotional, trial or one-time initial credit                                                                | denied                                                                     |
| Paid or priced model                                                                                         | denied                                                                     |
| Model explicitly excluded (incompatible or unavailable)                                                      | denied                                                                     |
| OpenRouter model that does not end in `:free`                                                                | denied                                                                     |
| Permanent, anonymous keyless access with an official source                                                  | allowed                                                                    |
| Recurring free tier with verified billing and a guaranteed hard stop, account confirmed free by the operator | allowed unless the native quota is exhausted                               |
| Same, without operator confirmation                                                                          | allowed only with a fresh (under 3 minutes) native quota reading of `SAFE` |
| Anything else                                                                                                | denied                                                                     |

### Fail-closed behaviour

`FREE_ONLY` defaults to `true`. In the code the relaxed mode exists only under `NODE_ENV=test`; in a normal run the check above always applies, whatever `FREE_ONLY` says. A request that fails the check returns "Geen geverifieerde gratis AI-route beschikbaar" (no verified free AI route is available) and nothing is sent.

### Setting it up

1. Start the stack and open the OmniRoute dashboard (port 20128, published by the compose file; restrict access to it on your network). Add your provider accounts there, and make sure each is on a genuinely free tier or has billing disabled. A "free" badge or signup credit does not prove recurring, zero-cost access.
2. In OmniRoute, create an API key for NOVA that is restricted to the model `auto` and to your verified connections. Put it in `OMNIROUTE_API_KEY` and set `OMNIROUTE_MODEL=auto` and `OMNIROUTE_ADMIN_PASSWORD` in `.env`.
3. Open **Instellingen → Slimme modellen → Gratis beleid maken** to generate the policy. Load choices explicitly, select active API-key accounts and recurring free models, provide official source URLs, and confirm the account facts. The wizard requires billing and automatic top-ups to be disabled, a guaranteed hard free limit, permission under the terms, acknowledgement of changes affecting other clients, and permission to refresh candidate metadata. One account per provider and at most 20 models are supported.

The wizard is the supported way to create the policy: it also binds it to each account's current credentials. Do not hand-edit `free-routing-policy.json`, and keep the live file out of Git. Check `GET /api/providers` for `ready: true`; any mismatch blocks inference.

The wizard uses **operator-account evidence** for economic safety, following the existing operator-confirmed classification. Your attestations establish billing disabled, guaranteed hard stop and entitlement to recurring free access; NOVA does not independently verify the supplied source URL or account billing. Native candidate metadata is checked only for the selected account/model's reported structural availability. Cached quota verdicts do not prove billing or current credentials, and the result explicitly reports `nativeQuotaVerified: false`. A ready route does not promise remaining quota or a successful model response; native strict enforcement stays enabled.

Loaded choices carry a private, signed inventory binding valid for ten minutes. Any account, credential, key restriction or settings change requires loading again and renewing the attestations. Changing selections also clears the attestations. Preparation is read-only. The apply step starts with a persistent inference stop, followed by native settings CAS, restriction of NOVA's key to the selected accounts and independent SQLite verification. Only then is the credential-bound policy replaced atomically with mode 0600; the prior policy receives a private backup once. Any partial or unknown outcome retains the stop, including after restart. The model has no wizard or account-management tool.

Revisions detect external changes between preparation and applying, and credential binding is checked before dispatch. Native settings, key restrictions and the local file have no shared transaction; external administrators can still race between checks or between verification and dispatch. NOVA does not claim an atomic lock over independent upstream administrators.

### What else NOVA uses OmniRoute for

- **Request headers.** Chat requests carry the NOVA session id (`x-omniroute-session-id`, `x-session-id`), opt out of OmniRoute's own automatic memory injection (`x-omniroute-no-memory`), choose compression with `x-omniroute-compression` (`lite` only when `NOVA_OMNIROUTE_COMPRESSION=lite`) and, when tools are offered, disable the response cache (`x-omniroute-no-cache`) so that device actions and live readings are never replayed from cache.
- **Native memory backend.** With `NOVA_MEMORY_BACKEND=omniroute`, long-term memory is stored in OmniRoute's native memory, scoped to NOVA's API key and entries tagged `application=jarvis`; search is keyword based, so no embedding model is needed. NOVA writes durable facts explicitly and injects retrieved memories as untrusted context.
- **Management reads.** With `OMNIROUTE_ADMIN_PASSWORD` NOVA logs in to the OmniRoute management API (fixed `/api/...` endpoints only) for the gateway status shown in the interface and the read-only tools `omniroute_status` (memory, skill catalog, compression, cache) and `omniroute_agent_skills` (documentation of Agent Skills; it installs and executes nothing). The model has no generic management proxy and no tool that changes OmniRoute settings. Private settings also offer account/catalog metadata on explicit request and changes to NOVA-owned native skill modes and full global prompt replacement; writes verify native persistence. The Native Gateway panel displays OmniRoute memory status and lets an administrator enable or disable it after a client-wide warning and fresh DANGEROUS confirmation; only the `enabled` field changes, and memory content remains outside that panel.
- **Embeddings** for the Qdrant memory backend, through OmniRoute's `/embeddings`, only when `EMBEDDING_FREE_VERIFIED=true` and a model and dimensions are set. See [Configuration](configuration.md#memory).

### Disabling or reverting

Set `NOVA_MEMORY_BACKEND=qdrant` and `NOVA_OMNIROUTE_COMPRESSION=off` and recreate the container. Memories already stored in OmniRoute stay there. Never replace OmniRoute's live database with an older copy; restore single settings through its management API instead.

### Numeric streaming compatibility

NOVA’s `nova-omniroute` image retains the audited upstream 3.8.51 digest and applies one guarded build-time compatibility patch. A Cloudflare issue documents that the Llama OpenAI endpoint sometimes emits JSON numbers in `delta.content`, where text is required ([Cloudflare issue 651](https://github.com/cloudflare/ai/issues/651)). The upstream gateway’s string-only content check drops these fragments; a clock answer can consequently arrive as `::` and contain nothing TTS can pronounce.

The patch converts only finite numeric content values to strings before the gateway’s existing validation. Existing strings (including leading zeroes), arrays, objects, booleans and null remain unchanged. It preserves tool calls, finish reasons and usage. It cannot reconstruct whitespace or precision already lost by the provider.

The build checks the upstream package version and requires exactly one matching compiled expression. An incompatible upstream update stops the build. There are no runtime interception hooks or additional credentials. Releases publish this small derivative as `ghcr.io/<owner>/nova:omniroute-X.Y.Z` alongside the matching NOVA version. Compose uses the same `NOVA_VERSION` for both images; existing gateway data mounts and configuration remain in place.

Local build and regression check:

```sh
node --test deploy/omniroute/repair-stream-content.test.mjs
docker build -t nova-omniroute:local deploy/omniroute
```

Before rolling back to a NOVA release predating 0.1.53, restore that release’s Compose file as well. Its upstream gateway image has the numeric-stream defect. Preserve `omniroute-data` throughout either direction; this patch performs no data migration.

### Administration API: verified baseline

Inspected 2026-10-10. NOVA’s gateway image derives from `diegosouzapw/omniroute@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218`. The 0.1.53 compatibility layer converts finite numeric OpenAI stream content to text before upstream validation; it changes no admin API, database format or provider configuration. An isolated, network-disabled image invocation reports package version **3.8.51**. The image bundles `docs/openapi.yaml`, `docs/reference/API_REFERENCE.md` and `.build/next/server/app-paths-manifest.json`; the manifest contains the routes below. The OCI labels identify the upstream repository but contain no build revision, so package version alone does not prove the exact build commit.

Contract research uses upstream tag **v3.8.51**, resolved commit `c1e30b7676975feb298b49eff6ff58923c04b89e`. The current default branch observed during research is `release/v3.8.52`; do not use its new contracts to assume support in the pinned image. Only shipped image files and public upstream source were inspected. No live credentials, database, live API calls or live changes were used. Method/body contracts are source-verified; end-to-end behavior against an isolated fixture remains to be tested.

Primary sources: [versioned API reference](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/reference/API_REFERENCE.md), [OpenAPI](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/openapi.yaml), [tagged source](https://github.com/diegosouzapw/OmniRoute/tree/c1e30b7676975feb298b49eff6ff58923c04b89e).

#### Session, authorization and failures

`POST /api/auth/login` accepts `{password: string}` and responds `{success: true}` with `Set-Cookie: auth_token=...`. Cookie settings are HttpOnly, SameSite=Lax, Path=/ and a 30-day maximum age; Secure depends on HTTPS/forced-cookie configuration. Missing JWT configuration returns 500; invalid JSON/schema returns 400; wrong password returns 401; disabled password login or restricted default-password use can return 403; lockout returns 429 with `Retry-After`. `POST /api/auth/logout` ends the session, and `GET /api/auth/status` returns `{authenticated: boolean}`. [Login implementation](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/auth/login/route.ts).

Management routes accept authenticated dashboard sessions and management-scoped credentials. Inference API keys without `manage`/`admin` scope are insufficient. Credentials in query/path do not authenticate management endpoints. Auth middleware and handler guards both matter: absence of a handler-level guard does not prove that a route is public. Authentication may be disabled by upstream configuration, but NOVA must still require its own settings authorization. [Management guard](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/lib/api/requireManagementAuth.ts).

NOVA's existing `OmniRouteManagement` already keeps the cookie server-side, shares concurrent login, renews once on 401, rejects redirects and uses ten-second timeouts. It currently collapses failures to status-bearing errors. Upstream errors vary: `{error: string}`, `{error: {message, details}}`, structured combo errors and centralized auth errors. Adapt them into bounded Dutch messages without passing raw credential-bearing bodies/logs to the browser. Respect 429; do not immediately loop retries. Reconfigure URL/password by dropping session and cached status.

#### Provider connections and accounts

Here “provider” API objects are **connections/accounts**, not only provider catalog definitions. A provider ID such as a catalog name is distinct from the persisted connection ID.

| Method and path                 | Request / response contract                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/providers`            | Optional `provider`, `limit`, `offset`; returns `{connections, total}`.                                                                                                                                                                                |
| `POST /api/providers`           | Required `provider`, `name`; `apiKey` required unless that provider explicitly permits none. Optional `priority` 1–100, nullable `globalPriority` 1–100, `defaultModel`, `testStatus`, `providerSpecificData`. Returns `{connection}` with status 201. |
| `GET /api/providers/:id`        | Returns `{connection}`; unknown ID returns 404.                                                                                                                                                                                                        |
| `PUT /api/providers/:id`        | Partial update; validated fields include `name`, `priority`, `globalPriority`, `defaultModel`, `isActive`, replacement `apiKey`, error/cooldown state and provider-specific data. Strict validation rejects unsupported keys.                          |
| `DELETE /api/providers/:id`     | Removes the connection and related model cleanup. Treat as destructive; reverify routing immediately.                                                                                                                                                  |
| `POST /api/providers/:id/test`  | Provider-specific connection probe; not evidence of permanently free billing.                                                                                                                                                                          |
| `GET /api/providers/:id/models` | Connection-specific model discovery; provider implementations may call their upstream model APIs.                                                                                                                                                      |

[Collection handler](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/providers/route.ts), [connection handler](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/providers/%5Bid%5D/route.ts), [provider schemas](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/shared/validation/schemas/provider.ts).

GET masks keys only when upstream key reveal is disabled; NOVA must always project a safe allowlist and return credential-presence flags rather than raw/masked upstream fields. Never trust upstream masking as the only boundary. Creating a connection may trigger background model sync, automatic provider testing and configured cloud sync. These are real side effects, not a local-only validation operation. OAuth accounts use separate provider-specific OAuth flows; `POST /api/providers` is not a universal OAuth account-creation endpoint. Do not invent OAuth support without a reviewed callback/session flow.

The pinned `PUT /api/providers/:id` accepts `apiKey` replacements only when the connection's `authType` allows it. NOVA narrows this to `authType=apikey`; OAuth and cookie sessions stay unavailable. This handler does not run the provider test endpoint, but it can sync to OmniRoute Cloud when that feature is enabled. The update has no compare-and-swap, so NOVA rechecks current state immediately before writing and verifies SQLite afterward while its durable inference barrier remains active. [Pinned update handler](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/src/app/api/providers/%5Bid%5D/route.ts), [API-key update predicate](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/src/shared/providers/webSessionCredentials.ts).

#### Combos and models

| Method and path                         | Request / response contract                                                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/combos`                       | Optional validated `limit`, `offset`; returns `{combos, total}`.                                                                                                                                                                                            |
| `POST /api/combos`                      | Required `name`, nonempty `models` array; optional `description`, `displayName`, `strategy` (default `priority`), `config`, `allowedProviders`, `allowedModelFamilies`, `system_message`, tool/context controls. Returns combo object directly, status 201. |
| `GET /api/combos/:id`                   | Returns combo object directly; not `{combo}`.                                                                                                                                                                                                               |
| `PUT` or `PATCH /api/combos/:id`        | Partial schema-validated update; `PATCH` delegates to `PUT`. Existing omitted values survive; supplied arrays replace previous arrays. Updates support `isActive` and model/provider restrictions.                                                          |
| `DELETE /api/combos/:id`                | Returns `{success: true}`; references/name invariants can reject deletion.                                                                                                                                                                                  |
| `GET /api/models?all=true`              | Model catalog with aliases; ordinary listing narrows active providers and configured visibility.                                                                                                                                                            |
| `GET /api/models/catalog`               | Catalog surface; model listing alone is not free-route authorization.                                                                                                                                                                                       |
| `GET /api/settings`                     | Flat settings object plus revision/runtime metadata; removes password hash, but broad settings still require NOVA's own safe projection.                                                                                                                    |
| `PATCH /api/settings` (`PUT` delegates) | Validated partial settings update, supports compare-and-swap with `If-Match`/`expectedRevision`. Sensitive authentication edits can require current password.                                                                                               |

[Combo collection](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/combos/route.ts), [combo updates](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/combos/%5Bid%5D/route.ts), [combo schemas](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/shared/validation/schemas/combo.ts), [settings handler](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/settings/route.ts).

Important correction: create-combo payloads use **`models`**, not a generic `providers` array, and the update activation field is **`isActive`**, not `active`. Model entries accept supported string or structured step forms defined in the tagged schema; keep an initial NOVA adapter deliberately narrow. Duplicate names, circular references, excessive DAG depth and provider constraints can reject changes.

Model exposure is persisted through settings: `modelVisibilityAllowlist`, `modelVisibilityDenylist`, `blockedProviders`, `hidePaidModels`, `freeAccessPolicy` (`off` or `strict`), `excludeTosAvoid`. Empty exposure arrays are a no-op upstream, not “deny everything”. NOVA's policy must therefore handle an empty selection by blocking inference, not treating it as restrictive. [Settings schemas](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/shared/validation/settingsSchemas.ts).

#### NOVA API keys, usage and limits

`GET /api/keys` returns `{keys, total, allowKeyReveal}` with masked keys. `POST /api/keys` creates a key and returns its **raw key once** alongside ID/configuration; retain that value only server-side. Request fields include `name`, `modelAccessMode`, `allowedModels`, `allowedCombos`, `allowedConnections`, `scopes`, expiry and budgets. `PATCH /api/keys/:id` edits restrictions; `GET` reads and `DELETE` removes it. Regenerate/reveal routes also exist; do not forward their secret results to NOVA's browser. [Key creation](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/keys/route.ts), [permissions update](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/keys/%5Bid%5D/route.ts).

Verified usage routes include `GET /api/usage/history`, `/api/usage/logs`, `/api/usage/:connectionId`, `/api/usage/model-latency-stats` and `/api/usage/provider-limits`. Latency stats accept `windowHours`, `minSamples`, `maxRows`, `provider`, `model`. Provider-limit GET returns cached `{caches, intervalMinutes, lastAutoSyncAt}`; POST triggers actual refresh. Token-budget `/api/usage/token-limits` supports GET/POST/DELETE. In pinned v3.8.51, token-limit uniqueness is `(api_key_id, scope_type, scope_value)`; POST upserts that row and can replace its interval, reset time, enabled state and limit. There is no compare-and-swap, so NOVA must not call this a separate budget per interval or claim conflict-free writes. Do not surface prompt/request bodies from usage logs; NOVA needs projected counts, timing, status and actual served model. [Latency handler](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/usage/model-latency-stats/route.ts), [cached limits](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/usage/provider-limits/route.ts), [token-limit API contract](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/reference/API_REFERENCE.md#token-limits).

#### NOVA integration constraints and unresolved checks

- Preserve the existing inference path through `RoutingService.assertFree()` and current read-only SQLite verification. Management changes do not establish free access by themselves.
- The free-policy wizard must coordinate upstream strict settings, exact model exposure and NOVA key restrictions with local `free-routing-policy.json`; save local policy atomically only with validated source evidence. Any partial update/drift must leave inference blocked.
- NOVA currently requires route `auto`, key restriction to `auto`, verified connection IDs and accepted catalog evidence. Creating/editing an ordinary combo does not automatically make it NOVA's inference route.
- Provider tests/model tests can contact upstream providers; avoid inference probes that bypass NOVA's free-only check. A health badge is not proof of free billing or model availability for every request.
- This research does not verify live auth mode, enabled key-reveal/cloud-sync settings, upstream quota availability, provider account plans or installed instance state. UI must distinguish unsupported/unavailable/unverified instead of inventing results.
- The image's app-path manifest proves route presence, not exact source-body equivalence. Its bundled reference and matching package/tag version support the selected baseline; fixture integration tests should verify response wrappers, CAS/error handling and authorization before claiming complete J3 implementation.

#### Native skills, prompts and memory

The pinned gateway has two separate skill systems. `/api/agent-skills` lists curated API/CLI/configuration documentation, with fixed detail and raw-Markdown reads. Its generator regenerates documentation; it does not create executable skills. `/api/skills` lists installed executable handlers, including other API-key owners. Project metadata only and restrict visibility to NOVA's owner plus the native global owners `system`, `skillsmp` and `skillssh`. Mode updates and deletion exist. `POST /api/skills/install` accepts handler code and unconditionally registers it enabled; it has no inactive staging option. Do not expose it as a generic proxy or claim a newly installed handler can be reviewed before activation. [Documentation catalog](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/lib/agentSkills/catalog.ts), [runtime registry](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/lib/skills/registry.ts), [runtime API](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/skills/route.ts), [install endpoint](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/skills/install/route.ts).

`/api/settings/system-prompt` reads/updates a single instance-wide prefix/suffix prompt, affecting all gateway clients. It is not a per-NOVA prompt library. The initial NOVA overview exposes enabled state and character counts; text/editing remains unfinished. Native memory supports CRUD, but NOVA already lists and mutates only its API-key owner with `metadata.application=jarvis`; preserve those checks. [Prompt API](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/settings/system-prompt/route.ts), [memory API](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/memory/route.ts).

Cookie-authenticated writes also pass upstream origin/CSRF validation; inspect and test that contract before adding mutations. Native skills may execute inside the gateway for nonstreaming requests when enabled. NOVA's chat client sends `x-omniroute-no-memory: true`, which the pinned gateway uses to skip memory and skill injection; the local `automaticExecution:false` describes NOVA's policy, not all clients of the gateway. [Auth pipeline](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/server/authz/pipeline.ts), [injection gate](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/open-sse/handlers/chatCore.ts).

NOVA can remove only a skill whose current SQLite `api_key_id` matches NOVA's owner, and verifies the row is absent after `DELETE /api/skills/[id]`. The pinned handler deletes by ID without an owner predicate, so NOVA rechecks ownership immediately before the request; the endpoint itself does not provide atomic owner-bound deletion. Keep shared/global skills unavailable for removal here. [Pinned delete handler](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/src/app/api/skills/%5Bid%5D/route.ts), [pinned registry deletion](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/src/lib/skills/registry.ts).

The pinned cookie-auth mutation pipeline permits server requests without an `Origin` header; NOVA's existing private management client already uses that branch. An invalid explicit origin can alternatively use a session-bound CSRF token, but cross-site Fetch Metadata cannot. Native skill PUT returns requested values without checking affected rows and does not invalidate the warm 60-second registry cache. Before exposing mode changes, check ownership and verify persisted mode through the read-only database; do not claim immediate runtime activation from the PUT echo or a cached GET. [Origin validation](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/server/origin/publicOrigin.ts), [skill update](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/skills/%5Bid%5D/route.ts).

#### System-prompt persistence requirements

The pinned `PUT /api/settings/system-prompt` accepts partial fields, but persists its supplied body as the entire `settings/systemPrompt` JSON value in `key_value`. Its runtime setter merges that body into the current process configuration. An omitted prefix/suffix can therefore remain active until restart while disappearing from the stored configuration. A NOVA editor must send the complete `{enabled,prefixPrompt,suffixPrompt}` object and independently verify that SQLite row; the GET response reads runtime memory and cannot prove persistence. The handler updates runtime before saving, so failures must not be reported as an unchanged gateway.

The dedicated prompt PUT does not accept the generic settings API's expected-revision parameter. Bind the change to a private hash of the stored row, reject local overlapping writes and recheck before PUT; external dashboard races have no atomic CAS guarantee. Keep proposed prompt contents and the expected revision in bounded private state, exposing only review metadata. Reject recognized secrets rather than silently saving redacted text. Any replacement must explicitly acknowledge that both prompt fields affect all gateway clients.

Primary tagged sources: [prompt handler](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/settings/system-prompt/route.ts), [settings persistence](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/lib/db/settings.ts), [runtime prompt state](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/open-sse/services/systemPrompt.ts). Investigation used source only; no live prompt or gateway change was made.

NOVA implements full global prompt replacement. Both new fields are supplied even when empty; existing text is never returned. Audit records contain enabled state and character counts only. The stored revision is checked before writing, then verifies both SQLite and runtime. This local guard cannot prevent an unrelated external administrator racing the dedicated upstream endpoint. Unknown post-write outcomes explicitly warn that the gateway may already have changed.

#### Account mutation boundaries

The pinned provider creation handler always starts `testSingleConnection` after initially saving an inactive account. Successful or unsupported validation can activate it asynchronously. The create schema has no `isActive` or skip-test option; `x-skip-model-sync` suppresses optional discovery only. Do not promise a disabled account or zero probe traffic through this endpoint. Configured cloud sync may run after persistence. [Provider creation](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/providers/route.ts), [validation schema](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/shared/validation/schemas/provider.ts).

Deletion also cleans quota snapshots, model/combination references, native pins and caches; no inference call was observed in that path. Cloud-sync failure can return an error after deletion. Key permission updates similarly return a request echo after persistence and sync. Verify absence or exact stored restrictions independently. Empty allowed connections permit every account upstream, so NOVA must always reject an empty approved set. [Deletion](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/providers/%5Bid%5D/route.ts), [key update](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/app/api/keys/%5Bid%5D/route.ts).

Generic settings CAS reads `_settingsRevision` from the settings namespace and compares/increments it in one transaction. A body `expectedRevision` is supported. It does not make provider, key, local policy and settings writes atomic together. Persist an inference barrier before the first management write and retain it through partial failures until fresh policy verification succeeds. [Settings transaction](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/src/lib/db/settings.ts).

The native candidate inspection endpoint does not filter by the supplied key's allowed connections/models. It expands logical model candidates into account rows and copies the pooled strict verdict; one safe account can therefore give an unsafe peer a null `freeAccessExclusion`. Do not use that row alone as per-account proof. Only an independently established singleton eligible pool can make its verdict account-specific. Cold inspection may start native quota metadata refresh; it performs no inference. [Candidate projection](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/open-sse/handlers/autoComboCandidates.ts), [strict filter](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/open-sse/services/autoCombo/strictZeroCostFilter.ts).

NOVA offers account deletion through private settings. The shared management barrier serializes operations within one NOVA process and persists the inference stop before any upstream write. SQLite verifies absence, then actual policy verification can release the stop; partial outcomes retain it. A memory latch prevents filesystem restoration failures from silently reopening inference. This is a single-process management design, not a cross-instance distributed lock.

## Home Assistant

The stack includes Home Assistant on port 8123 with host networking. Finish onboarding at `http://<nova-host>:8123`, create a long-lived access token and set `HOME_ASSISTANT_TOKEN` (and `HOME_ASSISTANT_URL` if yours runs elsewhere). NOVA only sees entities allowed by its Home Assistant access policy and risk rules (`apps/api/src/home/risk.ts`): locks, covers, scenes, scripts, toggles, announcements and Sonos grouping need confirmation, unlocking is `DANGEROUS`. Effects are verified against the entity state where possible.

- **Music and media.** NOVA controls the real media-player entities it can see: play, pause, stop, skip, set or mute volume, play an exposed Sonos favorite, announce through an installed Home Assistant TTS source. When Music Assistant exposes `play_media`, `music_play` takes a library name, provider URI or a short phrase (for example `rustige jazz` with type `radio`); without Music Assistant NOVA says so and does not claim playback started. All of these run at once, without asking first. Results are checked against the player state when it exposes enough.
- **To-do lists.** Local lists use a matching Home Assistant `todo` entity automatically, see [Features](features.md#timers-lists-and-cooking).
- **Energy.** NOVA watches up to 100 `sensor` entities with `device_class: power` in W, kW or mW and keeps a 30-minute rolling sample in its private state file. After six samples it alerts on a reading of at least 1,500 W that is also at least 2.5 times that sensor's recent average, then stays quiet for that sensor for an hour. kWh totals are not instantaneous power; with no eligible sensor the check is inactive. The thresholds are fixed, so verify units before relying on them. Read-only.
- **Device inventory.** NOVA compares the `device_tracker` entity ids from its normal state sync, using the first successful sync as the baseline and raising informational alerts for additions and removals. It stores no IP or MAC addresses and a failed sync never counts as devices disappearing. This detects changes in Home Assistant's tracker inventory, not every device that joins your Wi-Fi; add a router integration in Home Assistant for that.
- **Presence** drives unsolicited speech, see [Features](features.md#proactive-behavior).

## Proxmox, Termix, Pangolin

- **Proxmox VE:** create an API token and set `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` (`PROXMOX_VERIFY_TLS=false` for a self-signed certificate). NOVA shows guests, storage and tasks and starts, stops and reboots guests when asked, without asking first.
- **Termix** (SSH hosts, with direct SSH fallback) and **Pangolin** are optional. Commands run at once; see the tool table in [Tools and safety](tools-and-safety.md).

## Calendar (CalDAV)

Configure **Settings → Koppelingen → Mail en agenda → CalDAV instellen** with the HTTPS collection URL, username and password or app password. Saved values apply immediately to the native calendar and reminders. Deployment `CALDAV_URL`, `CALDAV_USERNAME` and `CALDAV_PASSWORD` remain fallback values (restart after changing the deployment environment). NOVA reads one CalDAV calendar collection. It sends a bounded `REPORT` for the next seven days, refuses redirects, limits the XML to 2 MiB and returns at most 40 events, sharing only summary, start, end, time zone and all-day status. Calendar text is untrusted data.

`calendar_events` and `daily_briefing` use this provider. `calendar_create` and `calendar_move` write one timed event with an exact title and times. Creation uses a server-generated UID and refuses overwrites; moving needs one exact title and start match plus the event's ETag, keeps time zone definitions, and refuses recurring, ambiguous, changed or out-of-collection events. The optional CalDAV MCP stays read-only.

Calendar reminders are off by default (**Helper → Meldingen → Rituelen**, 5, 15 or 30 minutes). NOVA checks once per minute and sends one info alert per upcoming timed appointment; all-day events and events without a stable UID are skipped. A private `0600` progress file stores only hashes of UID and start time.

## News

Without settings NOVA reads NOS's public RSS topics (`algemeen`, `binnenland`, `buitenland`, `politiek`, `economie`, `tech`, `cultuur`, `opmerkelijk`, `sport`). To use your own, set `NOVA_NEWS_FEEDS` as a JSON array of up to five `{ "name", "url" }` entries and restart:

```dotenv
NOVA_NEWS_FEEDS=[{"name":"NOS","url":"https://feeds.nos.nl/nosnieuwsalgemeen"},{"name":"Tweakers","url":"https://feeds.tweakers.net/nieuws"}]
```

Feeds are read in parallel (500 KB and seven seconds each), up to ten headlines are combined with their source names, and unavailable feeds are skipped. Only HTTP(S) URLs without credentials are accepted and the address is re-checked at fetch time, including redirects, to block private targets. Feed text is untrusted.

## Routes and travel time

`route_estimate` calculates a route between two places on request, for car, bike or walking, with distance, estimated minutes and attribution. **There is no live traffic.** With `NOVA_HOME_LAT`/`NOVA_HOME_LON` or Home Assistant `zone.home` set, a destination is enough. Place names are resolved with the Open-Meteo city geocoder (no street addresses) and the routing service receives only two coordinates. Create a free Standard key at [openrouteservice](https://openrouteservice.org/plans/), set `OPENROUTESERVICE_API_KEY` in the local `.env` and restart the API; without it the tool is not offered. With a CalDAV calendar NOVA can give departure advice for one appointment if you give its exact title and the destination place (the calendar has no reliable address field), using the start time, the car route and a 15-minute margin. It is advice only and sets no alarm.

## Urgent phone notifications (ntfy)

NOVA can publish `critical` alerts to an ntfy topic. Subscribe the ntfy app to a private topic on a server NOVA can reach, create a publish-only access token, then set `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` and restart. `NTFY_URL` may be HTTPS, or HTTP only for `ntfy`, `localhost` or `127.0.0.1`. NOVA sends only the sanitized alert title at urgent priority (never details, arguments or results), suppresses repeats with the same key and title for 15 minutes, and logs delivery failures without the endpoint or token. All alerts remain in the feed. See [ntfy publishing](https://docs.ntfy.sh/publish/).

## Optional local Piper voice

Edge voices are the default. NOVA can use the medium English voice from [jgkawell/jarvis](https://huggingface.co/jgkawell/jarvis) (an emulation of the movie voice, MIT-licensed model) through a separate local Piper container, because Piper's runtime is GPL-3.0-or-later; neither the model nor the runtime is in the NOVA image or repository.

```sh
node scripts/download-jarvis-voice.mjs                                              # pinned model (about 61 MiB) into dev-data/piper
docker compose -f docker-compose.dev.yml --profile personal-voice up -d --build piper   # port bound to loopback
```

Set `NOVA_PIPER_TTS_URL=http://127.0.0.1:5000/synthesize` for the dev API and restart; the voice then appears in the sound settings as "Engels (lokale Piper-stem)" and is synthesized locally as WAV. In production copy `dev-data/piper/en_GB-jarvis-medium.onnx*` to `nova-data/piper-voices/`, set `NOVA_PIPER_TTS_URL=http://piper:5000/synthesize` in the host's private `.env`, then run `docker compose --profile personal-voice up -d --build piper nova`. Keep the model and that `.env` on the personal host.

## Node-RED and MQTT

Node-RED is a required service of the Compose stack. It owns orchestration across time and events (schedules, retries, event-to-service wiring, flows you write yourself). NOVA stays the authority for credentials, tool schemas, risk labels, allowlists, validation and audit. A flow that asks NOVA to do something goes through a narrow bearer-token boundary and is treated like a chat request. Flow input and output are untrusted and bounded.

Contents: [Boundaries](#boundaries-mqtt-and-http) · [Seed and persistent data](#seed-flows-and-persistent-data) · [NOVA nodes](#the-nova-nodes) · [Templates and routines](#templates-and-routines) · [Embedded editor](#embedded-editor) · [Packages](#node-packages) · [Logs](#logs) · [Health heartbeat](#health-heartbeat) · [Verification](#verification)

### Boundaries (MQTT and HTTP)

In production Node-RED is reachable only on the internal Compose network. The development stack publishes port 1880 on localhost only. NOVA reads flow tab counts from the local Admin API; the settings inventory shows only tab id, name, status, node count and API revision, never flow definitions or credentials.

#### Flows to NOVA

Trusted flows send alerts or runtime errors to `POST /api/integrations/node-red/events`. Set `NODE_RED_EVENT_TOKEN` (at least 32 characters) to the same value for NOVA and Node-RED, and send `Authorization: Bearer <token>`:

```json
{"type":"alert","title":"Backup finished","detail":"Nightly backup completed","severity":"info"}
{"type":"runtime_error","detail":"Flow backup reported an error","flowId":"tab.123"}
```

The endpoint accepts only these two event types, at most 4 KiB per payload and 60 accepted events per minute. Alerts enter the bounded notification feed. Runtime errors update the Node-RED health summary, and an optional short `flowId` links to the matching tab in the flow inventory. Event text is untrusted display data: it cannot invoke tools or trigger a model response. The audit log stores only event type and severity. Node-RED's Admin API has no "latest runtime error" endpoint, so flows must report errors themselves.

From a built-in Function node:

```js
msg.headers = { authorization: `Bearer ${env.get("NODE_RED_EVENT_TOKEN")}` };
msg.url = "http://nova:8080/api/integrations/node-red/events";
msg.method = "POST";
msg.payload = { type: "alert", title: "Flow done", severity: "info" };
return msg;
```

Never put the token in a flow export or in the repository; read it from the environment. In development, point `msg.url` at the host address of the NOVA API.

#### NOVA to flows

NOVA can trigger only flows listed in `NODE_RED_FLOW_ALLOWLIST`. It posts to the fixed path `/_nova/flow/<id>` with `NODE_RED_FLOW_TOKEN`. The flow needs an HTTP-in node on that path that validates the bearer token and answers through an HTTP Response node within ten seconds. Input is limited to 4 KiB and 32 top-level fields, the response to 16 KiB of JSON, and NOVA returns at most 8 KiB of sanitized text. The flow's configured risk goes through the normal confirmation and audit path. Arbitrary URLs and generic proxying are not supported.

#### MQTT

MQTT is a publish-only status and event bus from NOVA. NOVA does not subscribe, so MQTT cannot send commands or notifications into NOVA. Every payload has `type`, `source: "nova"`, `severity`, `timestamp` and sanitized `data`. The topic prefix is still `jarvis/`.

| Topic                        | Publisher                  | Data                                                                         |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `jarvis/status/api`          | MQTT connection lifecycle  | Retained `online`, plus a retained offline last will.                        |
| `jarvis/status/proxmox`      | Proxmox connection tracker | Retained `online` boolean after a Proxmox request.                           |
| `jarvis/events/tool`         | Tool runner                | Tool name, success flag, elapsed ms; no arguments or result.                 |
| `jarvis/events/conversation` | Chat controller            | Session id, response length, model, elapsed ms; no message text.             |
| `jarvis/events/timer`        | Timer scheduler            | Timer id, label, fired-at, whether it was late (the label is user-authored). |
| `jarvis/alerts`              | Checks and watchdog        | Alert id, key, severity, title, detail, timestamp.                           |
| `jarvis/events/proxmox`      | State/event store          | Proxmox state changes from the watchdog.                                     |
| `jarvis/events/system`       | State/event store          | System state changes from the watchdog.                                      |
| `jarvis/events/web`          | none yet                   | Allow-listed for future use.                                                 |
| `jarvis/status/node-red`     | none yet                   | Allow-listed for future use.                                                 |

The alert and state topics carry more descriptive fields than the tool and conversation topics. Restrict broker access and do not forward them to public brokers or logs without review. The Compose file ships no Mosquitto configuration, so broker authentication is up to you.

### Seed flows and persistent data

The reviewed seed lives in `deploy/nodered/` (`flows.json`, `settings.js`, `package.json`, `seed-entrypoint.sh`, and the local `node-red-contrib-nova` package). The entrypoint copies each seed file only when its destination is missing, so upgrades never overwrite operator flows, credentials or installed nodes in `nodered-data/`. The local NOVA node package is the exception: it is reinstalled from the read-only seed mount when its version changes.

To publish a flow change, export the flow(s) from the editor as formatted JSON into `deploy/nodered/flows.json` without credentials. `node scripts/check-nodered-flows.mjs` rejects credential-like values and embedded tokens; `node scripts/test-nodered-flows.mjs` imports the seed into an isolated Node-RED 4.1 container. NOVA's settings can download the validated live flows as a bounded JSON array behind the PIN (credential fields and likely secrets are rejected). NOVA never writes live flows into the tracked seed.

The production stack does not publish the editor. If you expose it through an authenticated reverse proxy, set `NODE_RED_EDITOR_URL`; settings then shows the link (credentials and query stripped).

### The NOVA nodes

`deploy/nodered/node-red-contrib-nova` ships five nodes. No public registry is involved.

| Node                 | Input                                                | Result                                                                                                  |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **NOVA zeg**         | Text in `msg.payload` (up to 2,000 characters)       | MPEG audio buffer in `msg.payload` for an audio output node. It controls no speaker itself.             |
| **NOVA vraag**       | Text in `msg.payload` (up to 10,000 characters)      | Reply in `msg.payload`, full sanitized chat result in `msg.nova`. Each node keeps its own chat session. |
| **NOVA melding**     | `{ title, detail?, severity? }` in `msg.payload`     | Bounded alert sent to the authenticated event API.                                                      |
| **NOVA briefing**    | Daily time or a stable `msg.novaEventId`             | Fixed read-only morning or evening summary with durable retries and idempotent feed acceptance.         |
| **NOVA gebeurtenis** | Error text or `{ detail, flowId? }` in `msg.payload` | Bounded runtime-error event sent to the authenticated event API.                                        |

Set `NOVA_API_URL` only when the default `http://nova:8080` is unreachable. The package accepts only `nova`, `localhost`, `127.0.0.1` or `host.docker.internal` and fixed API paths; message data cannot choose a URL. Chat requests cannot pass model overrides. Event nodes read `NODE_RED_EVENT_TOKEN` from the Node-RED environment, store no secret in flow JSON, cap requests at 4 KiB, time out, and bound API errors; TTS responses are capped at 2 MiB.

**Proactive mode.** `NOVA vraag` has an opt-in proactive mode for scheduled flows. It calls the bearer-protected `/api/proactive/ask`, exposes only enabled `READ_ONLY` tools, rejects any tool whose prepared risk is higher, accepts no attachments, keeps no history and allows ten requests per minute. Ordinary `NOVA vraag` nodes keep the regular chat route.

**Durable briefings.** `NOVA briefing` keeps its schedule, bounded retries and reply outbox across Node-RED restarts. Daily slots catch up within four hours, pending replies reuse the same acceptance id, and restarted history stays silent.

### Templates and routines

When `NODE_RED_ADMIN_TOKEN` has `flows.write`, `NODE_RED_EVENT_TOKEN` is set, and the target flow has a unique `tabId` in `NODE_RED_FLOW_ALLOWLIST`, NOVA can add one of a few fixed templates. NOVA writes only these fixed nodes; it never generates Function-node code or arbitrary nodes. The Node-RED revision is checked before deployment and every new node is verified afterwards.

- **Foutmelding** (error alert): a Catch node, a fixed formatter and `NOVA melding`. It reports catchable errors of the selected tab, not runtime crashes or errors a node only logs.
- **Offline-melding**: a Status node scoped to existing nodes in the tab, a filter for `disconnected`, `offline` or `error`, a formatter and `NOVA melding`.
- **Ochtendbriefing / Avondoverzicht**: the durable `NOVA briefing` node. The default times are 07:30 and 20:30 and you choose the time. The evening overview uses up to 12 successful action names and times from the local action log, open lists, timers, alerts and tomorrow's appointments; arguments and results are excluded.
- **Daily reminder routine**: a request such as "remind me every day at 07:45 to put the bin outside" adds a daily time trigger, a formatter and `NOVA melding`. The schedule uses the host time zone, and the text is kept out of durable action logs. Delete a routine from the flow in Node-RED.

Existing fixed briefing schedules appear in the flow inventory. Changing their time or time zone is a separate action with whole-flow revision checks and exact verification; an empty daily time keeps event triggers and disables the schedule. Other flow creation and arbitrary code generation are not supported. Replace an old operator-written briefing chain explicitly to get the durable behavior.

### Embedded editor

Open **Instellingen → Koppelingen → Node-RED → Floweditor → Editor openen** to edit flows inside NOVA. Opening is explicit; closing the editor or leaving the section revokes its session and WebSocket connections. Deploy changes with Node-RED's own **Deploy** button.

NOVA connects to the local `NODE_RED_URL` with `NODE_RED_ADMIN_TOKEN` on the server; the browser receives neither the token nor the upstream address, and no extra published port or `NODE_RED_EDITOR_URL` is needed. The editor requires HTTPS (HTTP on localhost works for development); access to it is whatever the reverse proxy in front of NOVA allows. A separate HttpOnly, Secure, same-origin editor cookie expires after 30 minutes and renews every five minutes while the editor is open.

The proxy supports flow loading, editing and deployment, debug messages, context, library entries and core node configuration. It does not expose native login, palette installation, projects, SSH keys, diagnostics or arbitrary runtime endpoints. Browser cookies and authorization headers are never forwarded upstream, and upstream error bodies are replaced with fixed messages.

### Node packages

**Instellingen → Koppelingen → Node-RED → Palette** lists only packages from `NODE_RED_PALETTE_ALLOWLIST`, which is empty by default. Listing a package does not install it; every install, version change or removal is applied when you choose it, without a further prompt. Prefer records with an exact version:

```json
[{ "name": "node-red-node-example", "version": "1.2.3" }]
```

This is a schema example, not a package recommendation. Names start with `node-red-node-` or `node-red-contrib-`, at most 20 unique names, versions are exact SemVer (no tags, ranges, URLs or paths). Name-only lists still work but install whatever npm currently serves, which NOVA states before confirming.

The overview shows the active version, the allowed target and any staged version. Node-RED performs the install and NOVA re-reads the inventory. A first install can be active at once; an upgrade is staged for a restart, reported with `verified=false`, and further installs stay blocked until that restart (which never happens automatically). The change binds the package list and inventory it was based on; if either changes you must reload and try again. Overlapping palette changes inside one NOVA process are refused, but a change made from the editor or another process cannot be excluded because the Node-RED API has no atomic revision. Package code runs with Node-RED's rights; a version pin does not review it. Inventory needs `nodes.read` and changes need `nodes.write`.

### Logs

**Instellingen → Koppelingen → Node-RED → Logboek en fouten → Logboek laden** fetches the last hundred lines of the Node-RED container on request (`GET /api/settings/stack-control/node-red/logs`, `Cache-Control: no-store`, no polling). The stack-control broker reads only the fixed Node-RED container, both streams, at most 64 KiB, with a five-second timeout; there is no caller-chosen container, live follow or Docker write.

The API validates the response and redacts known environment secrets, Bearer tokens, URL credentials, password and key fields, private key blocks (including partial ones) and long Base64 lines; a long line is hidden entirely so a truncated secret cannot leak as a prefix. Your own flow text can still contain private data, so show this panel only where appropriate. Logs are not stored and not sent to a model or the audit log. **Open flow** appears only when node type and name identify exactly one node in the current flow configuration.

### Health heartbeat

NOVA checks the local Node-RED Admin API and reports availability changes to the alert feed after the first sample (the first sample is silent). The summary exposes only reachability, tab count and explicitly reported runtime errors.

The seeded **NOVA health heartbeat** flow calls `http://nova:8080/api/health` every 60 seconds (first check after 15 seconds). A failed request sets an in-memory outage flag; when the API answers again the flow posts one recovery alert to the event endpoint using `NODE_RED_EVENT_TOKEN` from the runtime environment (not stored in `flows.json`). NOVA cannot receive an alert about its own outage, so Node-RED records the outage locally and reports recovery; the flag resets when Node-RED restarts. Existing installations import `deploy/nodered/flows.json` through the editor to get it.

### Verification

```sh
npm test --prefix deploy/nodered/node-red-contrib-nova   # node behavior
node scripts/check-nodered-flows.mjs                     # seed has no secrets
node scripts/test-nodered-flows.mjs                      # seed in an isolated Node-RED 4.1
npm run test:nodered-seed                                # seed entrypoint
npm run test:node-red-editor:runtime                     # embedded editor (needs built API, Docker, Playwright Chromium)
npm run test -w @nova/api -- test/settings/node-red-editor-access.test.ts test/settings/node-red-editor-policy.test.ts test/settings/node-red-editor-controller.test.ts test/settings/node-red-editor-proxy.test.ts test/settings/node-red-editor-websocket.test.ts
```

The editor runtime check starts its own temporary Node-RED on loopback and never touches the production instance. `npm run test:compose-notification` proves an event travels from a seeded flow through the real API to the (mocked) helper speech endpoint; it does not prove audible playback on a PC.

## MCP servers

This policy applies before NOVA adds or updates an MCP server. MCP tools run as external programs and their output is untrusted data. A server is an optional integration: if a requirement cannot be verified, NOVA must leave it disabled.

### Process isolation work in progress

`deploy/stack-control/mcp-sandbox.mjs` creates fixed offline containers for sequential-thinking,
filesystem and workspace Git. It accepts only a reviewed server identifier and, for Git, a project ID.
Commands, image, environment, mounts and network policy are constructed by the trusted broker.
The container has no external network, capabilities or credentials; its root is readonly and its
memory, CPU and process count are bounded. Git can read only its selected project. Filesystem access
stays confined to the configured workspace. Creation precedes transport attachment and start.
Outside fixture tests, NOVA's sequential-thinking, filesystem and workspace Git clients use this
broker transport. It requires the private `NOVA_STACK_CONTROL_URL` and a 64-character hex
`NOVA_STACK_CONTROL_TOKEN`; the official Compose configuration shares that token with stack-control.
A missing or unavailable broker leaves these tools unavailable rather than starting an unrestricted
process. Git tool arguments are fixed to the selected project's path inside the container.

The authenticated upgrade stream forwards stdout JSON lines and discards stderr. Both directions
have message limits; healthy sessions remain connected until a peer disconnects or the broker stops.
Disconnects remove the owned container. Cleanup retries are bounded, and graceful broker shutdown
closes active streams and waits for cleanup. Failed removals retain their runner capacity reservation.
At startup the broker also removes recognized offline MCP workers that have remained in the
never-started `created` state for at least five minutes; active workers are preserved.

Run `npm run test:mcp-sandbox` for policy and lifecycle tests. Run
`npm run test:mcp-sandbox:runtime` to use the already cached image of the running `nova` container,
or set `NOVA_MCP_SANDBOX_TEST_IMAGE` to another cached NOVA image. The runtime gate uses a temporary
workspace and container; it neither pulls images nor edits the running stack. It checks a real MCP
initialization alongside failed direct internet/provider connections and then removes the container.

IMAP and CalDAV also use broker-created containers. Each receives only its three provider credentials, with no workspace or private data mount. These two workers use Docker bridge networking and fixed read-only tool lists; their egress is not destination-bound. Context7 retains its dedicated destination-bound relay. No production provider falls back to direct execution inside the NOVA container.

### Admission checks

Record the package/repository, exact version, source URL, license, review date, release/maintenance evidence, requested permissions, required configuration, expected network destinations, telemetry behavior, and each tool's proposed risk. Recheck this information immediately before installation; an older review is not approval for a new version.

Accept a server only when all of these checks pass:

- **Real and maintained:** verify the canonical upstream repository and package identity. Prefer a stable release from the last 12 months. If there has been no release in that period, require recent upstream maintenance and evidence that security reports are handled. Reject abandoned, placeholder, typosquatted, or unverifiable packages.
- **License:** verify a recognized license in the exact source being installed and that it permits this use and redistribution. Record the license and pin the reviewed source/version. Reject missing, conflicting, or unclear licensing.
- **No telemetry:** inspect the documented behavior and source/configuration for analytics, tracking, or unsolicited reporting. Disable opt-out telemetry explicitly where possible. If telemetry cannot be ruled out, do not add the server.
- **No model/provider bypass:** the server must not call or expose a separate language-model or AI-provider service. All model traffic must continue through NOVA's OmniRoute free-route checks. See `docs/tools-and-safety.md`; an unverified server stays disabled.
- **Free to use:** no paid plan, metered API, purchase, or required paid key. A user-provided credential is not proof that a service is free. Document any public-service rate limits and terms.
- **Minimum permissions:** grant only the smallest required directories, accounts, scopes, environment variables, and network destinations. Prefer read-only and a narrowly scoped workspace. Never pass the full process environment or broad host access.
- **Pinned installation:** use an exact package version and lockfile or immutable image digest; verify the package source and integrity. Include it in the image or controlled install directory. Do not download or update packages when NOVA starts.
- **Honest per-tool risk:** review each tool's actual effects and data access. The server's `readOnlyHint` is advisory and cannot lower a reviewed risk. Missing or invalid risk metadata keeps the server offline. New or unclear tools default to `CONFIRM`; only a separately reviewed, demonstrably read-only tool may be lowered. The label is recorded in the audit log; it does not make NOVA ask first.
- **Bounded operation:** define connection/call timeouts, output limits, logging that excludes secrets and sensitive contents, failure behavior, and how to disable/remove the server. A failure must not block NOVA or silently retry an action.

### Review record and user choice

Before adding a server, show the user its purpose, exact version, license, maintenance evidence, permissions, network destinations, telemetry finding, costs/limits, tool list and risk levels, and the consequences of enabling it. Ask whether to add it. Approval covers only that version, configuration, and reviewed tools; an update or permission/risk change needs a new review and choice.

Store the review date and evidence with the server's inventory entry. Recheck before every update and at least once a year. Disable the server if its source disappears, license changes, maintenance ends, telemetry or provider use is found, or a new tool exceeds the approved permissions. Preserve the previous pinned version for rollback when practical.

### Required verification

Run package/source checks, configuration validation, MCP handshake and tool-list tests, risk classification tests, timeout/output-bound tests, secret-redaction tests, and a NOVA startup test with the server absent or failing. Do not claim a live service or its privacy behavior was verified when only fixtures or source review were used.

### Workspace Git MCP review (2026-10-11)

`mcp-server-git==2026.8.18` is installed in the NOVA image from PyPI (MIT); it is launched on demand, with no credentials or inherited environment, and no network access is needed for the exposed operations. NOVA starts a fresh process for the active project and supplies its exact path through `--repository`; it also overwrites the server's `repo_path` argument internally. The upstream path validator permits arbitrary paths when `--repository` is omitted, so both constraints are required. Only status, diff, log, show and branch listing are callable; the server's add, commit, reset, checkout and branch creation tools remain unavailable. MCP text passes the code-secret scanner and is tagged as untrusted. Git init runs only in the isolated project sandbox and requires fresh DANGEROUS confirmation. This review was checked against the [PyPI release](https://pypi.org/project/mcp-server-git/), [upstream tool and launch documentation](https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md), and [upstream repository-path issue](https://github.com/modelcontextprotocol/servers/issues/4550). The built image's MCP handshake and status call passed; the app's default configuration does not start Git MCP unless a code tool is used.

### Model-provider declaration gate (2026-10-11)

Before NOVA registers tools from an MCP process, it scans the configured server identity/command/args/environment and the advertised tool names, descriptions, and schemas. Explicit provider names/endpoints/credentials and model-call shapes cause the whole server connection to be rejected. API tests include both metadata cases and a real stdio fixture that advertises an OpenAI chat tool. This is a declaration filter, not a source-code sandbox: a malicious or obfuscated executable can make outbound model calls without advertising them. L1.2 remains partial until MCP execution is restricted to source-reviewed identities or network policy can enforce the provider denylist.

### Runtime launch allowlist (2026-10-11)

Production MCP launch now accepts only exact command/argument/environment identities for the four packages in `deploy/mcp-servers.json`: sequential-thinking 1.0.0, Context7 4.3.0, filesystem 1.0.0 (fixed to `/data/workspace`), and arxiv 0.8.2 (fixed to `/data/arxiv`). Package versions are pinned in the image. Unknown server IDs, changed commands, extra arguments, workspace widening, and custom environment variables are rejected before process start. The separate Git MCP path also uses only the fixed image-installed `/opt/git-mcp/bin/python`; the runtime path can no longer be overridden through configuration. Unit tests cover the production rejection path and assert that the shipped config stays within the launch catalog. Fixture servers are permitted only under `NODE_ENV=test`.

The pinned Context7 MCP server makes outbound requests to Context7's documentation API when its tools are called. Its source also initializes OpenTelemetry instrumentation; in this stdio configuration it exposes no metrics listener and no exporter is configured, so the reviewed path records local metrics rather than sending telemetry to a third party. This is distinct from a model-provider call. Recheck this behavior against the exact package source on every version change. The official source references are [Context7 MCP v4.3.0](https://github.com/upstash/context7/tree/%40upstash%2Fcontext7-mcp%40v4.3.0/packages/mcp), [Sequential Thinking v1.0.0](https://github.com/modelcontextprotocol/servers/tree/%40modelcontextprotocol%2Fserver-sequential-thinking%401.0.0/src/sequentialthinking), and [Filesystem v1.0.0](https://github.com/modelcontextprotocol/servers/tree/%40modelcontextprotocol%2Fserver-filesystem%401.0.0/src/filesystem). The filesystem server can modify only the one directory passed in its fixed arguments. The pinned arXiv source review is recorded below.

This raises the bar for new servers: source review, exact package pin, minimal launch identity and tests must land together before a production entry is accepted. It still does not provide per-process network isolation. The declaration scan and source review cannot prove that a compromised or malicious pinned release has no hidden provider call. L1.2 remains open until an enforceable egress boundary closes that gap.

### arXiv MCP review (2026-10-11)

The selected package is `arxiv-mcp-server==0.8.2` from PyPI, Apache-2.0, released 2026-10-08. PyPI publishes the wheel SHA-256 `11cb0f60064242028c823ffc78825774340cec644bfb26eaa2917d8d45eb32f7`; the repository requires Python >=3.11 and has a current security policy. The stdio process is installed in its own Python environment, runs under NOVA's unprivileged user, and stores downloaded papers under `/data/arxiv`. No API key is required for basic arXiv search/read. `citation_graph` optionally contacts Semantic Scholar and has unauthenticated rate limits; no key is configured. Base install excludes PDF and local semantic-search extras. Search/read metadata tools are read-only; all other tools remain CONFIRM by default and `unwatch_topic` is DANGEROUS. The server advertises `semantic_search` and `reindex` even without the `[pro]` extra; NOVA disables both explicitly so neither a local model nor model download is exposed. The entry is disabled until enabled in NOVA settings. The source declares seven research prompts, but NOVA's MCP hub does not expose prompts or invoke another model. Review references: [PyPI package and release](https://pypi.org/project/arxiv-mcp-server/), [upstream README/tool list](https://github.com/blazickjp/arxiv-mcp-server), [upstream security policy](https://github.com/blazickjp/arxiv-mcp-server/blob/main/SECURITY.md), and [upstream dependency manifest](https://github.com/blazickjp/arxiv-mcp-server/blob/main/pyproject.toml). The image installs the package; telemetry terms were searched in its installed source with no matches. An MCP handshake listed 19 tools; provider guard accepted declarations and NOVA's config disables semantic embedding tools. No external search API was called.

### CalDAV MCP review (2026-10-11)

`@ni-c/caldav-mcp@0.1.4` is pinned from npm with a committed lockfile; reviewed upstream tag commit `02a668f963a9d114b7fbc9f23505653c6c81a2dd`, MIT. It uses Basic or Bearer auth, removes auth variables from its own environment after parsing, requires TLS by default, and rejects non-loopback plaintext unless explicitly overridden. Authenticated requests stay on the configured origin; server-provided hrefs are checked before use and redirects are rejected or constrained to same-origin discovery. Source inspection found no telemetry or AI/provider calls; this was not a CVE audit. The API key/password never enters NOVA's MCP JSON, audit, status or confirmation payload. The exact reviewed identity passes only references to the private deployment environment.

The catalog entry is disabled when added. Its immutable environment fixes `CALDAV_READ_ONLY=true` and an allowlist of `list_calendars`, `list_events`, `get_event`, `search_events`, and `get_free_busy`; write tools are not registered. All five receive explicit READ_ONLY risk. The image installs dependencies from `deploy/mcp-servers/caldav/package-lock.json`; credentials must stay in the deployment's ignored `.env`, never in Git. The server is optional and the existing native `calendar_events` tool remains available. The user confirmed that ordinary chat may route agenda-derived answers through OmniRoute; this permission does not place credentials in prompts, logs or repository files.

Source: [exact v0.1.4 package README](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/README.md), [configuration](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/config.ts), [HTTP client](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/api.ts), [tool catalogue](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/tools/catalogue.ts), [npm package](https://www.npmjs.com/package/%40ni-c/caldav-mcp).

### IMAP MCP review (2026-10-11)

`@ni-c/imap-mcp@0.5.2` is pinned from npm with a committed lockfile, MIT license, Node 22+ requirement, and published integrity `sha512-BgkSvPXCNpi/+miu/gBIZPvL5Cviz0LYI9bSUwFOSe7tJLpcg0PjieEGlyCepzYde2cDMjcD2fSxfHfhNjATjA==`. The npm package points to `ni-c/imap-mcp`; the upstream repository shows 96 commits but only three stars and no GitHub release. This is a narrow source/configuration review, not an independent security audit. The pinned tarball contains no SMTP client or provider/model API call path; mailbox connections use IMAPFlow. TLS is fixed to implicit TLS on port 993, certificate validation stays enabled, and the insecure-TLS option is not passed.

NOVA's exact process identity passes only private `IMAP_HOST`, `IMAP_USER`, and `IMAP_PASSWORD` references. The catalog adds it disabled. Its immutable environment sets `IMAP_READ_ONLY=true`, `IMAP_SEEN_KEYWORD=""`, and `IMAP_ALLOW_TOOLS=list_messages,get_message`. The allowlist excludes `list_new_messages` (which writes an IMAP keyword), attachment access, and every mailbox write tool. The server's attachment resources are also not forwarded by NOVA's MCP hub. Both exposed tools use read-only mailbox access and `BODY.PEEK`; NOVA wraps all returned MCP text as untrusted content before it reaches the model. For user-facing mail summaries, NOVA instructs the model to return sender, subject and a short gist, without quoting the body or following embedded instructions; no outgoing-mail tool is available. Values entered in Settings are stored separately in local `mcp-secrets.json` with mode 0600; deployment `.env` remains an optional initial value source. Neither config, status responses, audit nor confirmations contain those values. No mailbox contents were fetched during package review.

CalDAV and IMAP environment values can be replaced or cleared in Settings. The API accepts only the three fixed field names for each reviewed server; values never return to the browser, blank replacements preserve existing values, and clear is explicit. An enabled process is refreshed after a save. CalDAV addresses must be HTTPS and cannot embed credentials; IMAP accepts a DNS hostname only. This is bounded configuration support, not arbitrary MCP environment editing.

The exact npm package, lockfile audit, TLS reachability check for the user's configured mail host, and read-only MCP handshake/tool list were verified locally. The real mailbox has not been queried. Source: [npm package and pinned integrity](https://www.npmjs.com/package/%40ni-c/imap-mcp), [upstream source and security notes](https://github.com/ni-c/imap-mcp), [upstream tool catalogue](https://github.com/ni-c/imap-mcp/blob/main/src/tools/catalogue.ts), [IMAP read tools](https://github.com/ni-c/imap-mcp/blob/main/src/tools/read.ts), and [RFC 9051 §6.4](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4).

### GitHub MCP review (2026-10-11)

The optional GitHub connector uses the official `github/github-mcp-server` v2.0.2 release (MIT, signed tag commit `eb47a99ddb866ca2b8a162920e6bda9521f33ebb`). The Linux x86_64 and arm64 release archives are checked against upstream's published SHA-256 checksums in the image build; the binary is not downloaded at runtime. The local handshake was run without credentials and made no GitHub API request. Exact-tag source scan found in-process field-selection counters called “telemetry” but no analytics transport or tracking endpoint; repository API traffic is the expected service behavior, not telemetry.

NOVA's fixed launch uses `--read-only`, only `issues,pull_requests,actions`, and an explicit six-tool allowlist: list/read issues, list/read pull requests, and list/read Actions runs. Code contents, job logs, search, and every mutation tool are not exposed. The application additionally filters the advertised tool list and checks the owner/repository arguments against its saved target before every call. The official server documents that read-only mode suppresses mutation tools even when requested, but it does not restrict the underlying token's access. Therefore Settings accepts only a fine-grained `github_pat_` token plus one owner/repository; these values stay in the private 0600 MCP secret store, and only owner/repository labels are returned to the PIN-protected screen. No classic PAT or deployment-environment fallback is accepted. Configure the PAT for only this repository with read-only Metadata, Issues, Pull requests and Actions permissions; GitHub remains off until the user adds and enables it. The API may contact GitHub for the requested repo data; no model-provider endpoint is configured by this server. MCP process egress is not isolated, so L1.2 remains partial. Tool text passes both general sanitization and exact redaction for privately stored MCP credentials before reaching model context.

The pinned `v2.0.2` [server configuration guide](https://github.com/github/github-mcp-server/blob/v2.0.2/docs/server-configuration.md) documents `--read-only` as a strict filter over write tools and separately warns that it does not narrow token authorization. The [immutable v2.0.2 release](https://github.com/github/github-mcp-server/releases/tag/v2.0.2) publishes the architecture archives and checksum file. This is a narrow config and behavior review, not a source-code security audit. No PAT was entered and no live repository was queried.

### Context7 process boundary (2026-10-13)

Context7 now uses the authenticated broker outside tests, with no direct-process fallback. Its pinned MCP executable runs in a read-only, unprivileged, networkless container. The only host mount is the read-only Context7 relay socket directory; model secrets, workspace and private application data are absent. A worker-local loopback adapter sends HTTP requests through that Unix socket. The separate relay owns TLS and fixes both SNI and Host to `context7.com:443`, with certificate verification enabled. It accepts only GET requests for `/api/v2/libs/search` and `/api/v2/context` with bounded, explicitly named parameters. Caller headers, credentials, CONNECT, upgrades, alternate paths and redirects are rejected. Responses are limited to 1 MiB, upstream calls to 15 seconds, and concurrent upstream calls to four.

The Compose relay runs as UID/GID 1000 with dropped capabilities and exposes no TCP listener. Deployment must create and own `nova-data/mcp-relay/context7` before startup; the socket uses mode 0660. Eight relay tests, two adapter/launcher tests and eight runner tests pass, including a real UID-1000 launcher with no effective capabilities. `npm run test:mcp-sandbox:context7-runtime` passes against the cached pinned MCP executable: authenticated broker attachment, initialization, tool listing and both documentation tools succeed through the socket, while direct internet/provider access fails. The upstream responses in this gate are controlled fixtures, not live Context7 requests. The disposable wrapper-image layer and containers are removed afterwards; the production image is unchanged. IMAP and CalDAV use the isolated network-worker policy below. arXiv and GitHub remain unavailable until their source-specific process boundaries are implemented.

### Provider worker policy (2026-10-19)

Production routes sequential-thinking, filesystem, Context7, IMAP and CalDAV through the authenticated broker; workspace Git uses the same transport separately. IMAP and CalDAV receive only their own host/URL, username and password in a bounded upgrade header, never in the request URL. Commands, image, tool lists and container limits are fixed by the broker. Their roots are read-only, capabilities are dropped, no host data is mounted, and Docker bridge networking permits their provider connections. IMAP uses TLS on port 993. These workers have general network egress rather than Context7's destination-bound relay.

Production still rejects arXiv and GitHub before resolving private credentials or starting a transport. A missing broker has no direct-process fallback. Settings can save provider credentials, add the reviewed IMAP/CalDAV catalog entry and enable it through **Opslaan en verbinden**. A missing owned MCP catalog is seeded once from the shipped defaults with mode `0600`; existing and explicitly external catalogs remain unchanged. Unit and transport tests use synthetic credentials; a real account connection must be checked with that account's configuration.

## Your own HTTP APIs

NOVA can learn an external API from a base URL and a credential, test it, register tools for it, keep it healthy and
combine it with other APIs. Code: `apps/api/src/apis/`. Tests: `apps/api/test/apis/` (local fake servers only; no internet).

> Status: no real third-party API has been tested. Everything below is verified against local fake servers that
> imitate OpenAPI 3, Swagger 2, GraphQL introspection, JSON-RPC, WSDL/SOAP and a no-spec API. See "Unverified" at the end.

### The key decision: specs are data, never code

"Self-programming" means NOVA writes a **declarative integration spec** (JSON: base URL, an auth scheme that references a
vault entry, operations with method/path/parameters/body schema/risk) that four built-in, tested adapters interpret
(`rest`, `graphql`, `soap`, `jsonrpc`). No model-generated or downloaded code ever runs. If an API needs something the
adapters cannot express (custom request signing, streaming, binary protocols), the engine says so and the answer is a normal
repository change reviewed by a human, not something NOVA applies by itself.

### How it works

1. **Connect** (`api_connect`, or Settings > Geavanceerd > API's). Input: base URL, optional token/key, optional
   `local_network`, optional docs URL. A token is moved into the encrypted vault before anything is logged.
2. **Discover** (deterministic, no model call). Read-only requests, in this order, all to the host the user gave:
   `/openapi.json`, `/swagger.json`, `/v3/api-docs`, `/v2/api-docs`, `/api-docs`, `/swagger/v1/swagger.json`,
   `/.well-known/openapi(.json)`, `/.well-known/api-catalog`; then a GraphQL introspection query on `/graphql`; then
   `?wsdl`; then JSON-RPC `rpc.discover` and `system.listMethods` (on the URL, `/rpc`, `/jsonrpc`); then the HTML pages
   `/docs`, `/redoc`, `/swagger-ui/` and `/` for links to a spec; finally a plain `GET` of the base URL. At most 40 requests
   and 20 seconds. Everything tried is reported.
3. **Learn.** The result is parsed into operations. Authentication is inferred from `securitySchemes`, `WWW-Authenticate`
   and 401 texts; without a hint NOVA tries bearer, `X-API-Key`, basic (when the secret contains `:`), `Authorization: Token` and
   finally a query parameter, and keeps the first that a read-only probe accepts.
4. **Test.** One read-only probe (`api_test` runs only `READ_ONLY` operations).
5. **Register.** Every enabled operation becomes a tool `api_<integration>_<operationId>` with a JSON-schema built from the
   spec, plus the generic `api_call` (integration + operation id + params) so the model never has to see hundreds of tools.
6. **Remember and maintain** (see below).

If nothing machine-readable is found, the integration is stored as `needs_info` and NOVA answers with what was tried, what is
missing and what you can provide: the documentation URL, the spec (OpenAPI/Swagger JSON, Postman collection v2.1, HAR, GraphQL
introspection JSON, OpenRPC, WSDL), or example requests as `curl`. Give them with `api_attach_docs`; the engine parses them
deterministically (a credential in a curl command, Postman auth or HAR header goes to the vault and never into the spec; lines like
`GET /v1/items/{id}` in pasted text are read as operations).

#### Tools

| Tool                            | Risk                 | Purpose                                                 |
| ------------------------------- | -------------------- | ------------------------------------------------------- |
| `api_connect`                   | SAFE                 | discover, learn, verify login, register tools           |
| `api_list`, `api_describe`      | READ_ONLY            | what is connected, operations, risk, status             |
| `api_test`                      | READ_ONLY            | read-only probe only                                    |
| `api_refresh`                   | SAFE                 | re-discover, report added/removed/changed               |
| `api_attach_docs`               | SAFE                 | learn from user-provided material                       |
| `api_configure`                 | SAFE                 | switch operations on/off, raise or lower the risk label |
| `api_remove`                    | CONFIRM (label)      | delete the integration and its credential               |
| `api_call`                      | the operation's risk | generic fallback for any operation                      |
| `api_<integration>_<operation>` | the operation's risk | one tool per learned operation                          |
| `api_workflow_plan`             | READ_ONLY            | plan across APIs and NOVA's own tools                   |

"SAFE" tools still need `NOVA_ENABLE_ACTIONS=true` like every non-read-only tool.

Tool list size: the per-operation tools are registered but a turn only receives the ones whose integration or operation words
match the request, at most 12 (`capApiOperationTools` in `tools/tool-selection.ts`); the meta tools are found through the same
ranking (Dutch and English aliases: koppel, integreer, verbind, endpoint, token, leer, swagger, ...) and `nova_tools_search`.
They are therefore always registered and discoverable, but not injected into every unrelated turn.

### Supported protocols and honest limits

| Protocol                        | Discovery                                                               | Calls                                                                             | Limits                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REST / HTTP+JSON                | OpenAPI 3.x and Swagger 2.0 (JSON), Postman 2.1, HAR, curl, route lines | path, query, header, JSON and form bodies                                         | **YAML specs are not parsed** (no YAML parser in the repo; convert to JSON). Only local `$ref`s are resolved. Pagination is not automated: the model passes the page parameters. Multipart uploads and binary responses are not supported. Only JSON, XML and text responses are accepted. |
| GraphQL                         | introspection                                                           | queries and mutations; the selection set is generated (2 levels of scalar fields) | Subscriptions (WebSocket) unsupported. Fields with required arguments inside the generated selection are skipped. Introspection disabled: attach the schema.                                                                                                                               |
| SOAP 1.1                        | WSDL 1.1 (operations, SOAPAction, flat request elements, endpoint)      | SOAP 1.1 document/literal wrapped and simple rpc                                  | Complex nested types become flat string parameters; SOAP 1.2, WS-Security and attachments are unsupported. The WSDL endpoint is only used for its path on the host the user gave.                                                                                                          |
| JSON-RPC 2.0                    | `rpc.discover` (OpenRPC), `system.listMethods`                          | named parameters, or free-form `params` when only names are known                 | Batches, notifications and WebSocket transport unsupported.                                                                                                                                                                                                                                |
| **gRPC**                        | **not supported**                                                       | **not supported**                                                                 | HTTP/2 framing and protobuf are outside the declarative adapters. NOVA reports this; a gRPC bridge would be a reviewed code change.                                                                                                                                                        |
| **WebSocket / SSE / streaming** | **not supported**                                                       | **not supported**                                                                 | Same: reported as a limit, never guessed.                                                                                                                                                                                                                                                  |

Authentication: API key in a header or query parameter, bearer, basic, custom header with prefix, OAuth2 **client credentials**
(token fetched from a token URL on the _same host_, cached until shortly before expiry, re-fetched when expired; there is
no refresh-token flow because client credentials do not need one). OAuth2 **authorization code / implicit flows need a browser
login and are not automated**: give NOVA an access token as a bearer token instead (it will expire and the maintenance check will tell you).
APIs without any spec need user-provided examples. Signed requests (AWS SigV4, HMAC headers) are not supported.

### Risk model

Per operation, from the spec alone (`risk.ts`):

- `GET`/`HEAD`/`OPTIONS` -> `READ_ONLY`.
- `POST`/`PUT`/`PATCH` -> `CONFIRM`. A `POST` is `READ_ONLY` only when the spec says so (`x-readonly`, `x-safe`) or its spec-supplied
  `operationId` starts with `search/query/list/get/find/lookup/fetch/read`.
- `DELETE`, or a name/path containing destroy, delete, remove, purge, reset, format, shutdown, reboot, wipe, terminate, drop -> `DANGEROUS`
  (a `GET` named `list...Deleted...` stays read-only).
- GraphQL: queries `READ_ONLY`, mutations `CONFIRM`; SOAP and JSON-RPC: `CONFIRM` unless the name is destructive, except the
  introspection methods `rpc.discover` / `system.listMethods`.

`risk` is the effective label; `floor` is what the engine proved. The user can raise or lower `risk` (`api_configure`), but it never goes below `floor`. The label is informational: every operation runs at once, and `READ_ONLY` marks what read-only background checks may call. API output is untrusted content (the `api` source is in `UNTRUSTED_SOURCES`) and instructions inside it are not followed.
Results are tagged `untrusted: true` and capped at about 12,000 characters (arrays lose whole items, with a marker).

### Security model

- **Vault.** `apis-secrets.json` (0600): every credential AES-256-GCM encrypted with its own IV and its reference as AAD. The key is a random
  32-byte file `apis.key` (0600) created on first use. It is deliberately not derived from any other secret: those
  are optional and can change, which would silently destroy stored credentials. Consequence: the protection is against leaked
  copies of one file (backups of `apis-secrets.json` alone), not against someone who can read the whole data folder.
  The learned specs live in `apis.json` (0600) and contain only vault references (`sec_xxxxxxxxxx`).
- **Host binding.** A credential is bound to the host it was first used with and is refused for any other host, so a prompt-injected
  `api_connect` to another host cannot send a stored credential there.
- **Redaction.** Every stored secret (raw, base64, URL-encoded, the password part of `user:password`) is registered with the global
  `sanitize()` redaction (audit log, memory, logs) and is also removed from API responses and error messages inside the engine.
  Tool arguments are cleaned in `prepare` before the audit: a raw `token` is replaced by `credential_ref`; pasted documentation is
  replaced by "[n characters of documentation]". Request headers are never echoed; a credential query parameter is removed from reported URLs.
- **Chat interception** (`chat/secret-intercept.ts`, called from `/api/chat` and `/api/chat-stream` before anything else): when a message
  contains a URL and a credential next to a word such as token / api key / bearer / authorization / sleutel / wachtwoord, the value
  goes to the vault and the text becomes `[geheim opgeslagen als sec_...]` plus a note telling the model to use `credential_ref`. The
  credential is bound to the URL's host when the message names exactly one. Detection is heuristic (see the test table): an unusual token with
  no keyword next to it is not caught, and other channels (voice, bridges) do not run it. If the vault is unavailable the message is dropped instead of passed on.
- **SSRF guard** (`safe-http.ts`). DNS is resolved by NOVA, **every** answer is checked, and the first allowed address is pinned for the
  connection (SNI and `Host` stay the original name), so the answer cannot change between check and use (DNS rebinding). Always blocked:
  link-local and cloud metadata (169.254.0.0/16, fe80::/10, `fd00:ec2::254`, 100.100.100.200), unspecified, multicast and reserved ranges,
  NOVA's own service names and NOVA's own port on loopback. Loopback and private ranges are blocked unless the user marked the integration
  as **local network**. Plain `http` is only allowed for local-network integrations. No credentials in URLs. Redirects: only same-host redirects
  of `GET`/`HEAD` are followed (each hop re-checked); a redirect to another host is refused and credentials never leave the origin they were configured for.
  Timeout 15 s, response cap 1 MB (truncated with a marker), content types limited to JSON, XML, text and form encodings, 60 requests per
  minute and 4 concurrent requests per integration (discovery has its own bucket).
- **Untrusted spec text.** Operation summaries and parameter descriptions come from a remote document and end up in the model's tool list; they
  are reduced to one short plain line (no control characters, no angle brackets). OpenAPI `servers` on another host are ignored (reported); remote `$ref`s are never fetched.
- **No egress isolation.** The engine restricts what it connects to; it does not replace a network-level egress policy (see [MCP servers](#mcp-servers)
  L1.2 for the open item for subprocesses). The API process itself can reach whatever its container can reach.

### Maintenance (`ApiMaintenanceService`)

A timer (every 15 minutes, `unref`, off under test) checks each integration whose stored `nextDueAt` has passed (daily; failures retry hourly,
so a restart neither skips nor repeats a check). A check runs the read-only probe and:

- **401/403**: status `credentials_expired`, enabled operations marked `degraded`, one alert (Dutch, plain next step: give a new token; NOVA never rotates
  a credential by itself). Giving the new token with `api_connect` (same URL) or in the settings page replaces the stored credential.
- **404/410/5xx/timeouts**: after three consecutive failures `degraded` (or `unreachable`) and an alert; `410` immediately. The probe operation is marked degraded.
- **success**: status back to `ready`, `degraded` flags and the alert cleared.
- **weekly re-discovery**: the new spec is diffed against the stored one. New operations, read-only or mutating, are enabled. Removed operations become `gone` and disappear from the tool list. A changed operation is updated inside the spec (self-healing, for example a
  renamed pagination parameter). A changed mutating operation is applied at once as well.
  A moved read path is healed from a same-host redirect. A failed re-discovery never wipes the learned spec. The alert tells how many operations were added, removed and changed.

Standing objectives ([Features](features.md#standing-objectives)) use a fixed list of templates and cannot watch an API operation yet; use this maintenance check, or ask `agent_run`.

### Combining several APIs

There is no separate workflow engine. `api_workflow_plan` lists, for a goal, the relevant operations of every connected API and NOVA's own tools (name, risk), and how to run
the plan: `agent_run` with the steps in the goal text. The agent keeps its turn, time and daily budgets, and every step runs at once.

Example: customers API (GraphQL) + tickets API (REST) + infrastructure (Proxmox tools).

> **Jij:** Koppel https://crm.acme.nl/graphql met token sk-test-0000
> **NOVA:** (het token is al in de kluis gezet voordat het model het zag) Gekoppeld: 14 acties, 9 lezend, 4 schrijvend, 1 gevaarlijk. Login gecontroleerd met een lezende aanvraag.
> **Jij:** Koppel ook https://tickets.acme.nl/api met token sk-test-1111, en kijk of klant Jansen openstaande tickets heeft waarvan de VM stuk is.
> **NOVA:** (`api_workflow_plan`) Plan: 1. `crm_q_customers(search="Jansen")` (lezen). 2. `tickets_listTickets(customer=..., status=open)` (lezen). 3. `proxmox_guests` (lezen). 4. Samenvatting. Zal ik dit als achtergrondtaak draaien?
> **Jij:** Ja. -> `agent_run` voert de drie lezende stappen uit; wil het ticket gesloten worden (`tickets_closeTicket`), dan doet NOVA dat meteen en meldt het achteraf.

An API with no spec:

> **Jij:** Leer de api op https://oud.acme.nl/service
> **NOVA:** Ik vond geen OpenAPI, GraphQL, WSDL of JSON-RPC (26 plekken geprobeerd, alleen lezen). De root geeft JSON terug, dus daar kan ik alvast uit lezen. Om meer te leren heb ik nodig: de URL van de documentatie, de spec als bestand of tekst, of een voorbeeld-curl.
> **Jij:** `curl -H "Authorization: Bearer ..." https://oud.acme.nl/service/orders/42`
> **NOVA:** (`api_attach_docs`, token naar de kluis) Geleerd: `GET /orders/{orders_id}` (lezen).

### Unverified

- No real third-party API was connected. Real specs are larger and messier than the fixtures (polymorphic schemas, circular references, vendor extensions, unusual auth, quirks in WSDL).
  Expect `needs_info` or partial results on some of them, and report them.
- OAuth2 client credentials only against a fake token endpoint; real servers may require other client authentication (body parameters instead of Basic) or scopes.
- HTTPS to public hosts (certificate validation, SNI, IPv6) was not exercised end to end; tests use loopback HTTP with the local-network flag. The pinned-address logic uses Node's `https.request` with `servername`.
- The chat interception heuristics were tested against a table of Dutch and English messages, not against real conversations.
- The settings page was type-checked and unit-tested, not tried against a live API.
- gRPC, WebSocket, SSE, YAML specs, SOAP 1.2/WS-Security, OAuth2 authorization code and request signing are not supported (see above).

## Telephony and conversations

Requested `phone_call` calls default to a two-way conversation, including requests to tell the time. Set `conversation=false` explicitly for an announcement that hangs up after playback. New conversation settings allow 25 seconds before the first silence reminder; saved idle times remain unchanged.

NOVA can place and receive phone calls through its own Asterisk PBX and talk with you, in a call or a hands-free browser session. Telephony is **off by default**. Asterisk is in the production Compose file under the profile `telephony`.

### What it is

- **Asterisk 22** (GPL-2.0, LTS) runs as its own container (`deploy/asterisk`, Compose profile `telephony`). NOVA drives it through the Asterisk REST Interface (ARI, HTTP and WebSocket); AMI is off.
- **Linphone** (GPLv3 or commercial licence) is the free SIP app on your PC or phone and registers as an extension on Asterisk. NOVA itself uses no liblinphone or `linphonec`: NOVA is an ARI application (`Stasis(nova)`), which is headless and maintained. A separate linphonec container would add a second, less maintained SIP stack for no gain.
- **What works:** status and registered extensions; calling an extension or an external number and speaking a text (TTS); hanging up; showing calls and events; an incoming call to extension `700` (a conversation with NOVA when conversations are on, otherwise a short notice and an alert); the doorbell number `710`, which raises a critical alert and rings the configured phones (the first to answer is connected).

### Security

- No default passwords: the ARI secret and every extension password are generated randomly (`telephony.json`, `0600`, in the data folder). The generated Asterisk configuration is in `dev-data/asterisk/conf` (`0600`).
- Extensions accept requests only from private networks (`deny=0.0.0.0/0` plus `permit` for RFC1918/CGNAT). All values are validated before they reach the config (no line injection); trunk passwords may not contain `; = # [ ] " ' \`.
- Ports in the dev Compose file are published on `127.0.0.1` only: SIP 5060 udp/tcp, ARI 8088 (always loopback) and RTP `10000-10100/udp` (change with `NOVA_RTP_START`/`NOVA_RTP_END`). Set `NOVA_SIP_BIND` to a LAN IP to let phones at home register. Never put SIP on a public address; use a VPN away from home.
- The container runs with `cap_drop: ALL` plus CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID and `no-new-privileges`.
- Tools: `phone_status` (READ_ONLY), `phone_call` (runs at once; at most 5 outgoing calls per hour and 2 at once), `phone_hangup` (SAFE). All tools are off while Telephony is off.
- The Linphone provisioning link is single-use and valid for 10 minutes; the XML contains the SIP password and can be downloaded from the settings.

### Setup

**Development.** Switch Telephony on in **Instellingen → Telefoon** (this generates the configuration), then `docker compose -f docker-compose.dev.yml --profile telephony up -d --build asterisk`. Add an extension, set Asterisk's address (a LAN IP, which needs the same `NOVA_SIP_BIND`) and connect Linphone through the single-use link or the XML file. Changes reload within about 5 seconds without a restart (only a different RTP range or modules needs one). `NOVA_ASTERISK_ARI_URL` defaults to `http://127.0.0.1:8088` and accepts only localhost, 127.0.0.1 or `asterisk`.

**Production (Compose).** `asterisk` is a service on the private `nova` network with no published ports; NOVA reaches ARI and AudioSocket internally (`NOVA_ASTERISK_ARI_URL=http://asterisk:8088` is fixed in the Compose file). The image is built locally from `./asterisk`: copy `deploy/asterisk` next to `docker-compose.yml` (releases ship it in `nova-compose.tar.gz`), add `telephony` to `COMPOSE_PROFILES` in `.env`, switch Telephony on once in NOVA (this creates the configuration in `nova-data/asterisk/conf`) and run `docker compose up -d asterisk`. The trunk to `sip.linphone.org` is an outgoing registration, so nothing needs to reach NOVA from outside. To let phones on your own LAN register, publish SIP/RTP yourself on a LAN IP (never `0.0.0.0`) in your own override; NAT or other networks need `external_media_address` and `local_net` in a custom transport section. Until there is an extension or trunk, Asterisk reports no PJSIP endpoints; NOVA shows that as "no extensions yet", not "unreachable".

### Spoken conversations

The first transport is the phone: call **700** from a Linphone extension, or have NOVA call you. Code: `apps/api/src/conversation/`. It is off by default.

`caller audio → voice-activity detection → speech-to-text (OmniRoute) → NOVA's normal chat pipeline (streaming) → sentence chunks → text-to-speech → audio back`

- **Turn-taking:** an utterance ends after 800 ms of silence. Speech while NOVA talks interrupts her (barge-in); a longer burst (300 ms) is then required so her own voice leaking back through the line does not cut her off.
- **Natural pace:** the first sentence is spoken as soon as it is complete; a short filler ("Even kijken.") is said when a tool runs or the model takes longer than 2.5 s. Markdown, links and code are never read aloud.
- **Hanging up:** goodbye phrases ("tot ziens", "doei"), silence ("Ben je er nog?", then hang up), a maximum duration (default 10 minutes, a setting) and `#` or `*` on the keypad.
- **Chat pipeline:** the same orchestrator as typed chat (session memory, persona, tools) with `inputMode: "voice"` and **read-only tools only**. Tools that change something are not offered over the phone.
- **One call at a time** (a second caller hears that NOVA is busy) to protect the free model quotas. Only metadata is audited, no transcripts.

**Speech-to-text.** NOVA never calls a speech provider directly; it goes through OmniRoute, fail-closed, so provider credentials stay there. Whisper models are not in OmniRoute's chat-oriented free-model inventory, so the speech path uses its own dedicated OmniRoute key:

1. Add a free **Groq** account in OmniRoute (**Instellingen → Slimme modellen → account toevoegen**, or the provider's own dashboard). OmniRoute supports `groq/whisper-large-v3-turbo`; Cloudflare Workers AI is not a transcription provider there.
2. Create an OmniRoute API key restricted to **exactly** `groq/whisper-large-v3-turbo` and to **that one connection**, and set `NOVA_STT_KEY` to it.
3. Set `NOVA_STT_MODEL=groq/whisper-large-v3-turbo`, `NOVA_STT_MODE=transcriptions` and `NOVA_STT_FREE_VERIFIED=true` (your declaration that the Groq organisation is on the free plan with no billing).

Before every request NOVA reads OmniRoute's own records (read-only) and sends nothing unless the key is active, restricted to exactly that model, and limited to one active connection of the model's provider. A widened key stops speech instead of spending. Measured: about 300 ms for a two-second Dutch sentence, transcribed exactly. Without `NOVA_STT_KEY` NOVA falls back to the chat key and requires the model to lie inside the verified free key scope (`NOVA_STT_MODE=chat-audio` with Gemini works that way but measured about 12 s or a 503).

Then switch on **Gesprekken** in the settings (language and greeting) and **Telefonie** so extension 700 exists. Asterisk reaches NOVA over **AudioSocket**: `NOVA_AUDIOSOCKET_HOST` (what Asterisk dials, default `nova`), `NOVA_AUDIOSOCKET_PORT` (8093), `NOVA_AUDIOSOCKET_BIND` (default `0.0.0.0`; do not publish this port). A connection is accepted only from a private address and only when its first frame carries a secret UUID that NOVA generated into the dialplan. With conversations on, extension 700 is `Answer(); AudioSocket(...)`; with them off it plays the short notice and raises the alert.

**Linphone and the SIP trunk.** Your own Linphone account lives at Linphone's server, not on NOVA's PBX. To reach NOVA from anywhere, and for NOVA to call you: create a **second** free Linphone account for NOVA and enter it as the SIP trunk in **Instellingen → Telefoon** (host `sip.linphone.org`; the password is stored locally, mode `0600`); add yourself under **Contacten** with your address and optionally "Mag met NOVA praten"; contacts must live on the trunk's domain. Then "Nova, bel mij en vertel dat de was klaar is" (`phone_call`, placed at once) works, and with conversations on NOVA calls and talks with you. A contact with "Mag met NOVA praten" who calls NOVA's Linphone address goes straight into a conversation; any other caller only raises an alert and rings the configured phones.

**Hands-free session in the browser.** The waveform button next to the microphone (aria-label "Gesprek starten/stoppen") starts a hands-free session; it never starts without a click. NOVA loops: listen, send the sentence after about 1 s of silence through the normal `ask` path (voice input mode), speak the answer, listen again. It ends on "stop", "tot straks", "dat was het", "bye" (as the whole sentence), the Stop button in the "Luistert" pill, 60 s without speech, or a tab hidden for 2 minutes. Silence and idle times can be tuned per browser with the localStorage keys `novaConvSilenceMs` (700-2500) and `novaConvIdleMs`. While NOVA speaks the recognizer is off (no echo loop); a microphone level meter (getUserMedia with echo cancellation and noise suppression) must stay above a conservative threshold for about 350 ms to barge in, then playback fades out in about 120 ms and the new speech is the next turn. The device chosen in the pill (or the helper settings, key `novaAudioInput`) is remembered, a missing device falls back to the default with a message, and permission denied, no device, busy or unplugged microphones each get a Dutch message. `no-speech` and `aborted` just restart listening (the idle timer ends the session); network and other errors retry with backoff (0.4, 0.8, 1.6 s) up to 3 times, then the session ends with a message. The wake word stays optional and unchanged, but a session cannot start while "Hey NOVA" listening is on (they would share the microphone). Code: `apps/web/src/lib/voice/conversation-logic.ts` (pure, tested), `conversation-session.svelte.ts` (browser glue), `components/shell/VoiceSession.svelte`.

**Conversation tests.** `npm -w apps/api test -- test/conversation test/telephony` covers the segmenter, chunker, STT gating, session behavior (barge-in, echo, idle, failures), the AudioSocket protocol over real TCP, the dialplan and contacts. `NOVA_TEST_ASTERISK=1` also starts a real Asterisk 22 container that dials extension 700 into NOVA over AudioSocket (`test/conversation/real-asterisk.test.ts`; speech-to-text and the model are fakes there). **Not covered:** no real two-way call over a SIP phone or Linphone app has been made, no real speech-to-text model is enabled by default, noise handling is energy based (no neural VAD), and the browser microphone path still uses the browser's own recognition (the session code is transport-agnostic, a WebSocket transport is the next step).

### Text messages from Linphone and the SIP relay

Linphone wraps every message in a CPIM envelope (`Content-Type: message/cpim`) and also sends typing indicators (`application/im-iscomposing+xml`) and receipts (`message/imdn+xml`). Asterisk's `res_pjsip_messaging` answers everything but `text/plain` with `415 Unsupported Media Type` before the dialplan or NOVA sees it, and the `andrius/asterisk` image cannot be patched. Outgoing texts from NOVA (ARI `sendMessage`, `text/plain`) always worked. So NOVA runs a small SIP relay (`apps/api/src/telephony/sip-relay/`, Node `net` only) between Asterisk and the registrar:

- The generated `pjsip.conf` sets `outbound_proxy=sip:nova:5070\;transport=tcp\;lr` for the trunk (on the endpoint and the registration; without `lr` PJSIP routes strictly and the proxy becomes the Request-URI, as the lab test showed). The relay listens on `0.0.0.0:5070` in the NOVA container, opens its own TCP connection to the trunk host (port 5060, fixed from the configuration, never from traffic) for each Asterisk connection, and passes everything through byte for byte, including CRLF keepalives. Both sides are split on `Content-Length` (fragmented and merged traffic, at most 16 KiB of headers and 1 MiB of body; garbage closes only that connection).
- Only `MESSAGE` requests from Flexisip to Asterisk are changed: `message/cpim` containing `text/plain` becomes `text/plain;charset=UTF-8` with only the text as body (other charsets are converted to UTF-8 and `Content-Length` is fixed). Typing indicators and receipts are not passed on; the relay answers them `200 OK` itself. Anything NOVA cannot read as text (images or files in CPIM, unknown types, text over 8 KiB, encrypted) also gets `200 OK` and is discarded and counted. `text/plain`, all other methods and all responses are untouched. Message content is never logged, only method, type and size.
- It also strips the top `Route` header when that points at the relay itself (like any proxy), otherwise the registrar would try to forward everything to `nova:5070`. Because requests now come from the relay, Asterisk identifies the trunk by the `From` domain (`identify_by=header`, `match_header=From: /@host/`) instead of the IP address.
- It is not an open proxy: only connections from the `asterisk` container's address are accepted (the name is re-resolved per connection), at most 8 at once, and 2 hours of inactivity closes one. Port 5070 is not in the Compose `ports:` and is reachable only on the internal `nova` network. SDP is untouched, so SDES-SRTP media stays end to end and calls are unchanged.

**Lifetime.** The relay starts with NOVA once Telephony is on and a trunk exists, and restarts itself (new target, new `pjsip.conf`) when the trunk changes or is removed. With NOVA down, Asterisk's registration fails and retries (the trunk has `retry_interval=15`, `forbidden_retry_interval=60`, `fatal_retry_interval=15`, `max_retries=1000000`), so **a NOVA restart or deploy means roughly 15-60 s without incoming calls or texts**; then Asterisk re-registers by itself (12 s after the relay returned in the lab test).

**Environment.** `NOVA_SIP_RELAY=auto|on|off` (default `auto`: on when `NOVA_ASTERISK_ARI_URL` points at `asterisk`, so in the Compose stack, off when NOVA runs on the host), `NOVA_SIP_RELAY_PORT` (5070), `NOVA_SIP_RELAY_PROXY_HOST` (the NOVA container's name as Asterisk sees it, default `nova`), `NOVA_SIP_RELAY_BIND` (`0.0.0.0`), `NOVA_SIP_RELAY_UPSTREAM_PORT` (5060). The relay always speaks plain TCP to the trunk; TLS to the registrar is not built in.

**Limits.** No attachments or images (Linphone sends them as HTTP file transfer inside a CPIM message, which is discarded and counted), no group chats and no LIME end-to-end encrypted chats, which are unreadable and counted as `unreadable` (see the encrypted-chat bridge below). The counter `unreadable` with `lastUnreadableAt` is meant so NOVA can later say a file was sent that cannot be read over the phone.

**Troubleshooting.** `/api/telephony/status` (field `sipRelay`) shows `listening`, `activeConnections`, `rejected`, `rewritten`, `answered`, `dropped`, `unreadable`, `lastUnreadableAt` and `lastError`. Check `docker exec nova-asterisk-1 asterisk -rx "pjsip show registrations"` (must be `Registered`) and `docker logs nova | grep "SIP relay"` (metadata only). `cannot listen: EADDRINUSE` means port 5070 is taken (`NOVA_SIP_RELAY_PORT`); `connection from a non-allowed address rejected` means something other than the Asterisk container tried to connect (or `asterisk` does not resolve); `upstream: ...` means the registrar is unreachable; `malformed SIP` means the other side did not send SIP. If texts do not arrive while `rewritten` does not grow, nothing comes through the relay (registration? `outbound_proxy` in `pjsip.conf`?). A high `unreadable` means the phone sends attachments or encrypted chats.

**Tests.** Unit and integration tests (`apps/api/test/telephony`) cover config generation and injection protection, ARI URL validation, Linphone XML and the single-use link, the service against a fake ARI (originate, play, hang up, incoming, doorbell bridge) and tool risk labels through `ToolsService`. A real Asterisk 22 plus a second Asterisk as SIP client on a temporary Docker network confirmed registration and "online" status, ARI auth, real Edge TTS through MP3 decode to 16 kHz WAV, an outgoing call where the receiver recorded about 4.5 s of speech, the incoming call to 700 raising an alert and the doorbell 710 raising a critical alert and bridging to the ringing extension (found and fixed along the way: `acl=` points at `acl.conf`, so per-endpoint `deny/permit` is used now, and Asterisk plays 16 kHz WAV only as `.wav16`). The relay has a lab test (`apps/api/test/telephony/real-asterisk-relay.test.ts`, `NOVA_TEST_ASTERISK=1`): a real Asterisk registers through the relay at a fake Flexisip, an INVITE from the registrar reaches Asterisk on the registered connection, a CPIM text arrives as `text/plain` and the reply goes back as a SIP MESSAGE, typing and IMDN get `200 OK` from the relay, and after a relay restart Asterisk re-registers itself. **Not verified:** a real Linphone app (the provisioning XML follows the lpconfig format but was not tried on a device), a real Flexisip or sip.linphone.org with the relay in the path, a real SIP trunk, the Piper voice, bridging to several phones, group and LIME chats, and file transfer.

### Encrypted Linphone chat (bridge)

Plain Linphone text arrives through Asterisk and the relay. Linphone's "secure" 1:1 chat rooms are different: not a SIP `MESSAGE` but a Flexisip conference-factory chat room with LIME/X3DH Double Ratchet keys, which needs a client that speaks that protocol, liblinphone. The bridge in `deploy/linphone-chat` does that (Compose profile `linphone-chat`).

**Status (18-10-2026).** Works in production on the existing NOVA account (a second device next to Asterisk): an encrypted (padlock) 1:1 message from the allowed contact is decrypted, answered by NOVA, and the reply returns encrypted in the same chat, checked with a real message from the Linphone app. Plain messages still go through Asterisk and the relay and calls are unchanged. The first rollout hit two live-only problems: the image had no CA certificates (TLS to Linphone failed) and the connection to the LIME key server failed because IPv6 had no route (IPv6 is now off in the SDK). Set `NOVA_CHAT_LOG_LEVEL=message` in `.env` to see chat-room and LIME events without message content; do not leave it on. Not yet checked: behavior after a long quiet period (re-registration, LIME key renewal), several allowed contacts at once, and a second device of the same person.

**Design: same account, two registrations.** The bridge uses the same Linphone account as the Asterisk trunk (the same SIP identity), so one account has two registrations at Flexisip:

```
Linphone (phone) ==E2E (LIME)==> Flexisip (sip.linphone.org) --- forks to all registrations of the account
                                   |                      |
                   Asterisk (trunk, via SIP relay)   linphone-chat (liblinphone, own device)
                   calls + plain text                encrypted 1:1 chat only
                                                            |  JSON + token, internal network `nova`
                                                      NOVA  POST /api/integrations/linphone-chat/message
```

The bridge fetches user and domain from NOVA (`POST .../allowlist` returns `identity` = `sip:<trunk.username>@<trunk.host>`, never the password); only the password is in a secret file you create. The only other requirement is a contact (the existing NOVA contact).

**Rules under forking** (Flexisip sends to every registration):

- **Calls:** the bridge never answers, rejects or ends anything. All audio, video and text codecs are off (`payload_type.enable(False)`) and `auto_send_ringing_enabled = False`, so the SDK itself refuses an INVITE at once with **488 Not Acceptable Here** (a 4xx, not a global failure), with no 180/183 and no 603. The call listener only counts (`callsIgnored` in `/health`). A 4xx from one branch lets Flexisip keep the other branches (Asterisk) running; a 603 would kill the whole call, which therefore never happens. Smoke test (real SDK): an INVITE with a PCMU/PCMA offer gives `100 Trying` and `488`, never 180, 183, 200, 480, 486 or 603.
- **Cleartext messages** are ignored (only counted as `cleartextIgnored`); the Asterisk route already answers them, so there is never a double reply. Only rooms with security level `Encrypted` or `Safe` from an allowed contact with exactly one other participant are answered; groups, strangers and `Unsafe` are not. The old option `NOVA_CHAT_ALLOW_CLEARTEXT` is removed (it would double replies).
- **Dedupe rule:** cleartext goes to Asterisk, encrypted to the bridge. Encrypted room messages are addressed to the bridge's device GRUU (`gr=urn:uuid:<device-id>`); Asterisk has no GRUU and no `+org.linphone.specs` group-chat capability, so it should not join a chat room (not verified that Asterisk sees nothing of the encrypted room).
- **200 OK on cleartext:** the SDK itself answers a cleartext `MESSAGE` with `200 OK` even though the bridge ignores the text. If Flexisip counts the first 2xx as "delivered" and stops, Asterisk would not get the message. Flexisip should send cleartext to all registrations, but this is **not verified**: check with the test below.
- **Device identity:** a fixed UUID in `/data/device-id` (`0600`, atomic) is given to liblinphone as `misc/uuid` and becomes `+sip.instance` in the Contact and so the GRUU the LIME keys belong to. User-Agent `NOVA-chat-bridge/0.2` (Asterisk: `NOVA-PBX`). Losing the volume means a new device and a new LIME enrolment.
- **No clash with Asterisk:** a different Contact (own `+sip.instance`, different address and port, TLS), its own User-Agent, `expires=3600` (like Asterisk), liblinphone refreshes itself. On stop only its **own** contact is unregistered (`Expires: 0`, never `Contact: *`). How Flexisip handles two registrations (maximum contacts per account, GRUU assignment) is not verified.
- **Receipts:** IMDN (delivered/read) and typing indicators to the sender are off (`im_notif_policy.clear()`); nothing leaves the bridge except real replies.

Message content never reaches logs (only states and counters; liblinphone log level Warning, never enable trace or debug). The bridge reads the allow-list from NOVA every minute (contacts with "Mag met NOVA praten"); empty or unreachable means nobody. Rooms of strangers and groups are left.

**What is in the repo.** `deploy/linphone-chat/Dockerfile` (multi-stage `ubuntu:24.04`, wheel `linphone-5.5.32-cp312` pinned with a **sha256 check**, a wrong hash fails the build, non-root uid 10001, 881 MB), `bridge.py` (the bridge), `test_bridge.py` (11 unit tests: policy, cleartext, groups, calls only counted, device id, no text in logs, NOVA client), `smoke_core.py` (smoke test with the real SDK and a fake registrar on 127.0.0.1), the `linphone-chat` service in `deploy/docker-compose.yml` (secrets, healthcheck, limits), `linphone-chat` sources in `nova-compose.tar.gz` (sources only; the image is never published because of GPLv3), and `apps/api/src/telephony/messaging*.ts` with `integrations/linphone-chat/{message,allowlist}`.

**Production, step by step** (as root in the folder with `docker-compose.yml`, usually `/opt/nova`, after unpacking a release that contains `linphone-chat/`):

1. Create the secret files without printing anything. The JSON keys in `nova-data/telephony.json` are `trunk.secret`, `trunk.username`, `trunk.host` and `messageToken`:

   ```sh
   install -d -m 0700 secrets
   ( umask 277; jq -je '.trunk.secret' nova-data/telephony.json > secrets/linphone_password \
     && jq -je '.messageToken' nova-data/telephony.json > secrets/nova_message_token ) \
     && chown 10001:10001 secrets/linphone_password secrets/nova_message_token \
     && ls -ln secrets && test -s secrets/linphone_password && test -s secrets/nova_message_token && echo OK
   ```

   The files are `0400`, owned by **uid 10001** (the container user; a root-owned 0400 file is unreadable for the container). `jq -e` fails if there is no trunk. Keep `secrets/` out of git.

2. Data folder: `install -d -m 0700 -o 10001 -g 10001 nova-data/linphone-chat`. A later `chown -R 1000:1000 nova-data` resets it, so repeat this line then. Whoever can read the folder can read the chats; do not put it unencrypted in a backup you share.
3. Build on the host (never push): `docker compose build linphone-chat` (downloads the wheel, checks the sha256, about 2 minutes).
4. Contact: in **Instellingen → Telefoon → Contacten** your Linphone address needs "Mag met NOVA praten" (the same list as for plain text).
5. Start: `docker compose --profile linphone-chat up -d linphone-chat` (or add `linphone-chat` to `COMPOSE_PROFILES`). Check `docker compose logs linphone-chat` (expect `registration state=Ok`, `started ... lime=True`) and `docker compose ps` (healthy).
6. Test: start a **secure** chat (padlock) with the NOVA account in your Linphone app. NOVA should answer in the same encrypted room.
7. Check forking: also send a **plain** text; you must get exactly **one** answer (from Asterisk) and `cleartextIgnored` in `docker compose exec linphone-chat /opt/venv/bin/python -I -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8099/health').read())"` must rise. No answer means Flexisip no longer delivers cleartext to Asterisk: turn the bridge off. **Call** the NOVA number: Asterisk must answer as before; `callsIgnored` rises and the Asterisk log shows no odd INVITE from the conference server.

**Roll back:** `docker compose --profile linphone-chat stop linphone-chat && docker compose --profile linphone-chat rm -f linphone-chat`, and remove `linphone-chat` from `COMPOSE_PROFILES`. Asterisk, relay and NOVA are unchanged (only `allowlist` returns an extra `identity` field). The bridge unregisters only its own contact; the device stays at Flexisip until the registration expires (1 hour). Clean up with `rm -rf nova-data/linphone-chat secrets/linphone_password secrets/nova_message_token` (the LIME keys are then gone; the next start is a new device).

**Tests run (2026-10-17):** `docker build` of the image (also with a deliberately wrong sha256: the build fails) and `docker compose config` with and without the profile; the 11 unit tests in the image (`python -I -m unittest discover -s /app -p 'test_bridge.py'`); the smoke test with `--network none` and a dead LIME URL (`docker run --rm --network none --entrypoint /opt/venv/bin/python nova-linphone-chat:local -I /app/smoke_core.py`), nothing sent to the real Linphone; the real `bridge.py` with a fake NOVA and a dead registrar (health 200, registration Failed, device-id created); and `npx vitest run test/telephony`. Found and fixed: the Python wrapper does not keep the listener alive, so without a reference there are **no** callbacks.

**Not verified:** behavior with two registrations at Flexisip as listed under the rules above (cleartext to both, Asterisk joining a chat room, maximum contacts, GRUU assignment), call forking beyond the SDK never sending 180/603, group chats, attachments, ephemeral messages (deliberately unsupported), several devices of the sender, and Linphone's terms of service for an automatically operated account (not checked; not legal advice).

**Risks.** A shared account: the bridge is an extra device with access to the account and the LIME keys, and whoever reads `nova-data/linphone-chat` reads the chats; the password is in `secrets/linphone_password` (`0400`). Dependence on Belledonne: wheels exist only for cp312/x86_64 and not on PyPI, so pin and keep the wheel, and smoke-test every liblinphone update again. Trust: the bridge sees the plain text and passes it to NOVA, so end-to-end ends in the bridge (on your own server). Size: the image is 881 MB, the first build takes about 2 minutes, and the Compose limit is 768 MB RAM and 1 CPU.
