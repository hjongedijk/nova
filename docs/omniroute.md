# OmniRoute and free routing

NOVA never calls a model provider directly. Every language-model request goes to [OmniRoute](https://github.com/diegosouzapw/OmniRoute), a self-hosted gateway that holds your provider accounts, picks a model (`auto`), tracks quota and fails over. NOVA adds one rule on top: **it only sends a request when it has verified that the route is free**, and otherwise it refuses to talk to any model. There is no paid, local or alternative-gateway fallback.

The compose stack pins the OmniRoute image by digest and sets `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=false`.

## What NOVA checks before every request

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

### Free-access classification

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

## Fail-closed behaviour

`FREE_ONLY` defaults to `true`. In the code the relaxed mode exists only under `NODE_ENV=test`; in a normal run the check above always applies, whatever `FREE_ONLY` says. A request that fails the check returns "Geen geverifieerde gratis AI-route beschikbaar" (no verified free AI route is available) and nothing is sent.

## Setting it up

1. Start the stack and open the OmniRoute dashboard (port 20128, published by the compose file; restrict access to it on your network). Add your provider accounts there, and make sure each is on a genuinely free tier or has billing disabled. A "free" badge or signup credit does not prove recurring, zero-cost access.
2. In OmniRoute, create an API key for NOVA that is restricted to the model `auto` and to your verified connections. Put it in `OMNIROUTE_API_KEY` and set `OMNIROUTE_MODEL=auto` and `OMNIROUTE_ADMIN_PASSWORD` in `.env`.
3. Open **Instellingen → Modellen → Gratis beleid maken** to generate the policy. Load choices explicitly, select active API-key accounts and recurring free models, provide official source URLs, and confirm the account facts. The wizard requires billing and automatic top-ups to be disabled, a guaranteed hard free limit, permission under the terms, acknowledgement of changes affecting other clients, and permission to refresh candidate metadata. One account per provider and at most 20 models are supported.

For manual setup, copy [the example policy](free-routing-policy.example.json) to `nova-data/free-routing-policy.json`. Replace every `example-*` value with the exact provider, model and connection IDs shown by OmniRoute. Confirm the model's terms, recurring free allowance, disabled billing/top-ups and guaranteed hard stop before setting the evidence booleans to `true`. `enabledModels` and `nativeModelAllowlist` contain `provider/model`; the latter must exactly match OmniRoute's model visibility allowlist. `blockedProviders` lists providers to exclude, not the verified provider. The NOVA key must be active, restricted to `auto` and exactly the verified connections; OmniRoute must have strict free access, hide paid models and exclude terms-to-avoid models enabled. Keep the live policy out of Git. Check `GET /api/providers` for `ready: true`; any mismatch blocks inference. The wizard is safer for normal use because it also binds the policy to each account's current credentials.

The wizard uses **operator-account evidence** for economic safety, following the existing operator-confirmed classification. Your attestations establish billing disabled, guaranteed hard stop and entitlement to recurring free access; NOVA does not independently verify the supplied source URL or account billing. Native candidate metadata is checked only for the selected account/model's reported structural availability. Cached quota verdicts do not prove billing or current credentials, and the result explicitly reports `nativeQuotaVerified: false`. A ready route does not promise remaining quota or a successful model response; native strict enforcement stays enabled.

Loaded choices carry a private, signed inventory binding valid for ten minutes. Any account, credential, key restriction or settings change requires loading again and renewing the attestations. Changing selections also clears the attestations. Preparation is read-only and expires after 60 seconds. Fresh, single-use DANGEROUS approval precedes a persistent inference stop, native settings CAS, restriction of NOVA's key to the selected accounts and independent SQLite verification. Only then is the credential-bound policy replaced atomically with mode 0600; the prior policy receives a private backup once. Any partial or unknown outcome retains the stop, including after restart. The model has no wizard or account-management tool.

Revisions detect external changes between preparation and confirmation, and credential binding is checked before dispatch. Native settings, key restrictions and the local file have no shared transaction; external administrators can still race between checks or between verification and dispatch. NOVA does not claim an atomic lock over independent upstream administrators.

## What else NOVA uses OmniRoute for

- **Request headers.** Chat requests carry the NOVA session id (`x-omniroute-session-id`, `x-session-id`), opt out of OmniRoute's own automatic memory injection (`x-omniroute-no-memory`), choose compression with `x-omniroute-compression` (`lite` only when `NOVA_OMNIROUTE_COMPRESSION=lite`) and, when tools are offered, disable the response cache (`x-omniroute-no-cache`) so that device actions and live readings are never replayed from cache.
- **Native memory backend.** With `NOVA_MEMORY_BACKEND=omniroute`, long-term memory is stored in OmniRoute's native memory, scoped to NOVA's API key and entries tagged `application=jarvis`; search is keyword based, so no embedding model is needed. NOVA writes durable facts explicitly and injects retrieved memories as untrusted context.
- **Management reads.** With `OMNIROUTE_ADMIN_PASSWORD` NOVA logs in to the OmniRoute management API (fixed `/api/...` endpoints only) for the gateway status shown in the interface and the read-only tools `omniroute_status` (memory, skill catalog, compression, cache) and `omniroute_agent_skills` (documentation of Agent Skills; it installs and executes nothing). The model has no generic management proxy and no tool that changes OmniRoute settings. Private settings also offer account/catalog metadata on explicit request and fresh confirmations for NOVA-owned native skill modes and full global prompt replacement; writes verify native persistence. The Native Gateway panel displays OmniRoute memory status and lets an administrator enable or disable it after a client-wide warning and fresh DANGEROUS confirmation; only the `enabled` field changes, and memory content remains outside that panel.
- **Embeddings** for the Qdrant memory backend, through OmniRoute's `/embeddings`, only when `EMBEDDING_FREE_VERIFIED=true` and a model and dimensions are set. See [Configuration](configuration.md#memory).

## Disabling or reverting

Set `NOVA_MEMORY_BACKEND=qdrant` and `NOVA_OMNIROUTE_COMPRESSION=off` and recreate the container. Memories already stored in OmniRoute stay there. Never replace OmniRoute's live database with an older copy; restore single settings through its management API instead.
