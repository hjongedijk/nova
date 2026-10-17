# API integration engine

NOVA can learn an external API from a base URL and a credential, test it, register tools for it, keep it healthy and
combine it with other APIs. Code: `apps/api/src/apis/`. Tests: `apps/api/test/apis/` (local fake servers only; no internet).

> Status: no real third-party API has been tested. Everything below is verified against local fake servers that
> imitate OpenAPI 3, Swagger 2, GraphQL introspection, JSON-RPC, WSDL/SOAP and a no-spec API. See "Unverified" at the end.

## The key decision: specs are data, never code

"Self-programming" means NOVA writes a **declarative integration spec** (JSON: base URL, an auth scheme that references a
vault entry, operations with method/path/parameters/body schema/risk) that four built-in, tested adapters interpret
(`rest`, `graphql`, `soap`, `jsonrpc`). No model-generated or downloaded code ever runs. If an API needs something the
adapters cannot express (custom request signing, streaming, binary protocols), the engine says so and the answer is a normal
repository change reviewed by a human, not something NOVA applies by itself.

## How it works

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

### Tools

| Tool                            | Risk                                | Purpose                                                               |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `api_connect`                   | SAFE                                | discover, learn, verify login, register tools                         |
| `api_list`, `api_describe`      | READ_ONLY                           | what is connected, operations, risk, status                           |
| `api_test`                      | READ_ONLY                           | read-only probe only                                                  |
| `api_refresh`                   | SAFE (CONFIRM with `apply_pending`) | re-discover, report added/removed/changed                             |
| `api_attach_docs`               | SAFE                                | learn from user-provided material                                     |
| `api_configure`                 | SAFE / CONFIRM                      | switch operations on/off, raise or lower risk, apply a pending change |
| `api_remove`                    | CONFIRM                             | delete the integration and its credential                             |
| `api_call`                      | the operation's risk                | generic fallback for any operation                                    |
| `api_<integration>_<operation>` | the operation's risk                | one tool per learned operation                                        |
| `api_workflow_plan`             | READ_ONLY                           | plan across APIs and NOVA's own tools                                 |

"SAFE" tools still need `NOVA_ENABLE_ACTIONS=true` like every non-read-only tool.

Tool list size: the per-operation tools are registered but a turn only receives the ones whose integration or operation words
match the request, at most 12 (`capApiOperationTools` in `tools/tool-selection.ts`); the meta tools are found through the same
ranking (Dutch and English aliases: koppel, integreer, verbind, endpoint, token, leer, swagger, ...) and `nova_tools_search`.
They are therefore always registered and discoverable, but not injected into every unrelated turn.

## Supported protocols and honest limits

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

## Risk model

Per operation, from the spec alone (`risk.ts`):

- `GET`/`HEAD`/`OPTIONS` -> `READ_ONLY`.
- `POST`/`PUT`/`PATCH` -> `CONFIRM`. A `POST` is `READ_ONLY` only when the spec says so (`x-readonly`, `x-safe`) or its spec-supplied
  `operationId` starts with `search/query/list/get/find/lookup/fetch/read`.
- `DELETE`, or a name/path containing destroy, delete, remove, purge, reset, format, shutdown, reboot, wipe, terminate, drop -> `DANGEROUS`
  (a `GET` named `list...Deleted...` stays read-only).
- GraphQL: queries `READ_ONLY`, mutations `CONFIRM`; SOAP and JSON-RPC: `CONFIRM` unless the name is destructive, except the
  introspection methods `rpc.discover` / `system.listMethods`.

`risk` is the effective level; `floor` is what the engine proved. The user can **raise** `risk` freely (`api_configure`),
**lowering** it asks for confirmation, and it can never go below `floor`. `CONFIRM` goes through the normal confirmation (and the autonomy level);
`DANGEROUS` always needs an on-screen confirmation. An operation is `routine` (may skip the question at higher autonomy levels)
only when it is a `GET` that the user raised to `CONFIRM`. API output is untrusted content: the `api` source is in
`UNTRUSTED_SOURCES`, so after any API result nothing is auto-approved for three minutes, exactly like web or MCP content.
Results are tagged `untrusted: true` and capped at about 12,000 characters (arrays lose whole items, with a marker).

## Security model

- **Vault.** `apis-secrets.json` (0600): every credential AES-256-GCM encrypted with its own IV and its reference as AAD. The key is a random
  32-byte file `apis.key` (0600) created on first use. It is deliberately not derived from `NOVA_APP_TOKEN`/`NOVA_ADMIN_PIN`: those
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
- **No egress isolation.** The engine restricts what it connects to; it does not replace a network-level egress policy (see `mcp-server-policy.md`
  L1.2 for the open item for subprocesses). The API process itself can reach whatever its container can reach.

## Maintenance (`ApiMaintenanceService`)

A timer (every 15 minutes, `unref`, off under test) checks each integration whose stored `nextDueAt` has passed (daily; failures retry hourly,
so a restart neither skips nor repeats a check). A check runs the read-only probe and:

- **401/403**: status `credentials_expired`, enabled operations marked `degraded`, one alert (Dutch, plain next step: give a new token; NOVA never rotates
  a credential by itself). Giving the new token with `api_connect` (same URL) or in the settings page replaces the stored credential.
- **404/410/5xx/timeouts**: after three consecutive failures `degraded` (or `unreachable`) and an alert; `410` immediately. The probe operation is marked degraded.
- **success**: status back to `ready`, `degraded` flags and the alert cleared.
- **weekly re-discovery**: the new spec is diffed against the stored one. New _read-only_ operations are enabled; new _mutating_ operations stay off until you approve
  (`api_configure`). Removed operations become `gone` and disappear from the tool list. A changed read-only operation is updated inside the spec (self-healing, for example a
  renamed pagination parameter). A changed mutating operation is stored as `pending` and applied only with your approval (`api_refresh apply_pending` or `api_configure apply_pending`, both CONFIRM).
  A moved read path is healed from a same-host redirect. A failed re-discovery never wipes the learned spec. The alert tells how many operations were added, removed, changed and await approval.

Standing objectives (`objectives.md`) use a fixed list of templates and cannot watch an API operation yet; use this maintenance check, or ask `agent_run`.

## Combining several APIs

There is no separate workflow engine. `api_workflow_plan` lists, for a goal, the relevant operations of every connected API and NOVA's own tools (name, risk), and how to run
the plan: `agent_run` with the steps in the goal text. The agent keeps its turn, time and daily budgets, read-only steps run by themselves, `CONFIRM` steps ask, `DANGEROUS` steps
need the screen confirmation, and API output pauses automatic approvals.

Example: customers API (GraphQL) + tickets API (REST) + infrastructure (Proxmox tools).

> **Jij:** Koppel https://crm.acme.nl/graphql met token sk-test-0000
> **NOVA:** (het token is al in de kluis gezet voordat het model het zag) Gekoppeld: 14 acties, 9 lezend, 4 vragen bevestiging, 1 gevaarlijk. Login gecontroleerd met een lezende aanvraag.
> **Jij:** Koppel ook https://tickets.acme.nl/api met token sk-test-1111, en kijk of klant Jansen openstaande tickets heeft waarvan de VM stuk is.
> **NOVA:** (`api_workflow_plan`) Plan: 1. `crm_q_customers(search="Jansen")` (lezen). 2. `tickets_listTickets(customer=..., status=open)` (lezen). 3. `proxmox_guests` (lezen). 4. Samenvatting. Zal ik dit als achtergrondtaak draaien?
> **Jij:** Ja. -> `agent_run` voert de drie lezende stappen uit; wil het ticket gesloten worden (`tickets_closeTicket`, CONFIRM), dan vraagt NOVA eerst.

An API with no spec:

> **Jij:** Leer de api op https://oud.acme.nl/service
> **NOVA:** Ik vond geen OpenAPI, GraphQL, WSDL of JSON-RPC (26 plekken geprobeerd, alleen lezen). De root geeft JSON terug, dus daar kan ik alvast uit lezen. Om meer te leren heb ik nodig: de URL van de documentatie, de spec als bestand of tekst, of een voorbeeld-curl.
> **Jij:** `curl -H "Authorization: Bearer ..." https://oud.acme.nl/service/orders/42`
> **NOVA:** (`api_attach_docs`, token naar de kluis) Geleerd: `GET /orders/{orders_id}` (lezen).

## Unverified

- No real third-party API was connected. Real specs are larger and messier than the fixtures (polymorphic schemas, circular references, vendor extensions, unusual auth, quirks in WSDL).
  Expect `needs_info` or partial results on some of them, and report them.
- OAuth2 client credentials only against a fake token endpoint; real servers may require other client authentication (body parameters instead of Basic) or scopes.
- HTTPS to public hosts (certificate validation, SNI, IPv6) was not exercised end to end; tests use loopback HTTP with the local-network flag. The pinned-address logic uses Node's `https.request` with `servername`.
- The chat interception heuristics were tested against a table of Dutch and English messages, not against real conversations.
- The settings page was type-checked and unit-tested, not tried against a live API.
- gRPC, WebSocket, SSE, YAML specs, SOAP 1.2/WS-Security, OAuth2 authorization code and request signing are not supported (see above).
