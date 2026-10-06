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
- The API key in `OMNIROUTE_API_KEY` is active, in `restricted` mode, may use only the model `auto`, and is limited to a non-empty set of connections that are all listed as verified in the policy (`verifiedConnectionIds`, or `verifiedProviders` when that is absent).
- Every provider in the policy's `blockedProviders` is also blocked in OmniRoute.
- The policy has at least one enabled model, and every enabled model is a catalog entry that is `nativeAutoEligible` and passes the free-access classification below.

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
3. Provide `free-routing-policy.json` in the data folder with the structure the code reads:

   ```json
   {
     "route": "auto",
     "status": "OK",
     "nativeFreeAccessPolicy": "strict",
     "enabledModels": ["<provider>/<model>"],
     "verifiedProviders": ["<provider>"],
     "verifiedConnectionIds": ["<connection id>"],
     "blockedProviders": ["<provider>"],
     "nativeModelAllowlist": ["<provider>/<model>"],
     "catalog": [
       {
         "provider": "<provider>",
         "modelId": "<model>",
         "freeType": "recurring-daily",
         "billingVerified": true,
         "hardStopGuaranteed": true,
         "accountFreeVerified": true,
         "nativeAutoEligible": true,
         "tos": "ok"
       }
     ],
     "providers": []
   }
   ```

   `providers` is an inventory that is only displayed. `nativeModelAllowlist` is optional.

> The repository does not contain a generator for this file. The original operator produced it with helper scripts that are not part of this repository, from the free catalog of the installed OmniRoute version. If you have no policy file, NOVA starts and the interface works, but chat is blocked with `POLICY_UNAVAILABLE` until you provide one that matches your OmniRoute configuration. Verify every entry against your own accounts; the operator's confirmation, never a provider label, is what makes an account count as free.

## What else NOVA uses OmniRoute for

- **Request headers.** Chat requests carry the NOVA session id (`x-omniroute-session-id`, `x-session-id`), opt out of OmniRoute's own automatic memory injection (`x-omniroute-no-memory`), choose compression with `x-omniroute-compression` (`lite` only when `JARVIS_OMNIROUTE_COMPRESSION=lite`) and, when tools are offered, disable the response cache (`x-omniroute-no-cache`) so that device actions and live readings are never replayed from cache.
- **Native memory backend.** With `JARVIS_MEMORY_BACKEND=omniroute`, long-term memory is stored in OmniRoute's native memory, scoped to NOVA's API key and entries tagged `application=jarvis`; search is keyword based, so no embedding model is needed. NOVA writes durable facts explicitly and injects retrieved memories as untrusted context.
- **Management reads.** With `OMNIROUTE_ADMIN_PASSWORD` NOVA logs in to the OmniRoute management API (fixed `/api/...` endpoints only, read-only use) for the gateway status shown in the interface and the read-only tools `omniroute_status` (memory, skill catalog, compression, cache) and `omniroute_agent_skills` (documentation of Agent Skills; it installs and executes nothing). The model has no generic management proxy and no tool that changes OmniRoute settings.
- **Embeddings** for the Qdrant memory backend, through OmniRoute's `/embeddings`, only when `EMBEDDING_FREE_VERIFIED=true` and a model and dimensions are set. See [Configuration](configuration.md#memory).

## Disabling or reverting

Set `JARVIS_MEMORY_BACKEND=qdrant` and `JARVIS_OMNIROUTE_COMPRESSION=off` and recreate the container. Memories already stored in OmniRoute stay there. Never replace OmniRoute's live database with an older copy; restore single settings through its management API instead.
