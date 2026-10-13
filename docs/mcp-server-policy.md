# MCP server selection policy

This policy applies before NOVA adds or updates an MCP server. MCP tools run as external programs and their output is untrusted data. A server is an optional integration: if a requirement cannot be verified, NOVA must leave it disabled.

## Process isolation work in progress

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
have message limits; sessions expire after 30 minutes and reconnect through the normal MCP lifecycle.
Disconnects remove the owned container. Cleanup retries are bounded, and graceful broker shutdown
closes active streams and waits for cleanup. Failed removals retain their runner capacity reservation.

Run `npm run test:mcp-sandbox` for policy and lifecycle tests. Run
`npm run test:mcp-sandbox:runtime` to use the already cached image of the running `nova` container,
or set `NOVA_MCP_SANDBOX_TEST_IMAGE` to another cached NOVA image. The runtime gate uses a temporary
workspace and container; it neither pulls images nor edits the running stack. It checks a real MCP
initialization alongside failed direct internet/provider connections and then removes the container.

Network MCP servers still use the direct stdio path. The destination-bound relay and its end-to-end
proof remain unfinished, so L1.2 is open. The running production image also needs an approved release
and deployment before it receives the offline transport; repository tests do not prove that rollout.

## Admission checks

Record the package/repository, exact version, source URL, license, review date, release/maintenance evidence, requested permissions, required configuration, expected network destinations, telemetry behavior, and each tool's proposed risk. Recheck this information immediately before installation; an older review is not approval for a new version.

Accept a server only when all of these checks pass:

- **Real and maintained:** verify the canonical upstream repository and package identity. Prefer a stable release from the last 12 months. If there has been no release in that period, require recent upstream maintenance and evidence that security reports are handled. Reject abandoned, placeholder, typosquatted, or unverifiable packages.
- **License:** verify a recognized license in the exact source being installed and that it permits this use and redistribution. Record the license and pin the reviewed source/version. Reject missing, conflicting, or unclear licensing.
- **No telemetry:** inspect the documented behavior and source/configuration for analytics, tracking, or unsolicited reporting. Disable opt-out telemetry explicitly where possible. If telemetry cannot be ruled out, do not add the server.
- **No model/provider bypass:** the server must not call or expose a separate language-model or AI-provider service. All model traffic must continue through NOVA's OmniRoute free-route checks. See `docs/tools-and-safety.md`; an unverified server stays disabled.
- **Free to use:** no paid plan, metered API, purchase, or required paid key. A user-provided credential is not proof that a service is free. Document any public-service rate limits and terms.
- **Minimum permissions:** grant only the smallest required directories, accounts, scopes, environment variables, and network destinations. Prefer read-only and a narrowly scoped workspace. Never pass the full process environment or broad host access.
- **Pinned installation:** use an exact package version and lockfile or immutable image digest; verify the package source and integrity. Include it in the image or controlled install directory. Do not download or update packages when NOVA starts.
- **Honest per-tool risk:** review each tool's actual effects and data access. The server's `readOnlyHint` is advisory and cannot lower a reviewed risk. Missing or invalid risk metadata keeps the server offline. New or unclear tools default to `CONFIRM`; only a separately reviewed, demonstrably read-only tool may be lowered. `DANGEROUS` remains subject to NOVA's normal confirmation rules.
- **Bounded operation:** define connection/call timeouts, output limits, logging that excludes secrets and sensitive contents, failure behavior, and how to disable/remove the server. A failure must not block NOVA or silently retry an action.

## Review record and user choice

Before adding a server, show the user its purpose, exact version, license, maintenance evidence, permissions, network destinations, telemetry finding, costs/limits, tool list and risk levels, and the consequences of enabling it. Ask whether to add it. Approval covers only that version, configuration, and reviewed tools; an update or permission/risk change needs a new review and choice.

Store the review date and evidence with the server's inventory entry. Recheck before every update and at least once a year. Disable the server if its source disappears, license changes, maintenance ends, telemetry or provider use is found, or a new tool exceeds the approved permissions. Preserve the previous pinned version for rollback when practical.

## Required verification

Run package/source checks, configuration validation, MCP handshake and tool-list tests, risk classification tests, timeout/output-bound tests, secret-redaction tests, and a NOVA startup test with the server absent or failing. Do not claim a live service or its privacy behavior was verified when only fixtures or source review were used.

## Workspace Git MCP review (2026-10-11)

`mcp-server-git==2026.8.18` is installed in the NOVA image from PyPI (MIT); it is launched on demand, with no credentials or inherited environment, and no network access is needed for the exposed operations. NOVA starts a fresh process for the active project and supplies its exact path through `--repository`; it also overwrites the server's `repo_path` argument internally. The upstream path validator permits arbitrary paths when `--repository` is omitted, so both constraints are required. Only status, diff, log, show and branch listing are callable; the server's add, commit, reset, checkout and branch creation tools remain unavailable. MCP text passes the code-secret scanner and is tagged as untrusted. Git init runs only in the isolated project sandbox and requires fresh DANGEROUS confirmation. This review was checked against the [PyPI release](https://pypi.org/project/mcp-server-git/), [upstream tool and launch documentation](https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md), and [upstream repository-path issue](https://github.com/modelcontextprotocol/servers/issues/4550). The built image's MCP handshake and status call passed; the app's default configuration does not start Git MCP unless a code tool is used.

## Model-provider declaration gate (2026-10-11)

Before NOVA registers tools from an MCP process, it scans the configured server identity/command/args/environment and the advertised tool names, descriptions, and schemas. Explicit provider names/endpoints/credentials and model-call shapes cause the whole server connection to be rejected. API tests include both metadata cases and a real stdio fixture that advertises an OpenAI chat tool. This is a declaration filter, not a source-code sandbox: a malicious or obfuscated executable can make outbound model calls without advertising them. L1.2 remains partial until MCP execution is restricted to source-reviewed identities or network policy can enforce the provider denylist.

## Runtime launch allowlist (2026-10-11)

Production MCP launch now accepts only exact command/argument/environment identities for the four packages in `deploy/mcp-servers.json`: sequential-thinking 1.0.0, Context7 4.3.0, filesystem 1.0.0 (fixed to `/data/workspace`), and arxiv 0.8.2 (fixed to `/data/arxiv`). Package versions are pinned in the image. Unknown server IDs, changed commands, extra arguments, workspace widening, and custom environment variables are rejected before process start. The separate Git MCP path also uses only the fixed image-installed `/opt/git-mcp/bin/python`; the runtime path can no longer be overridden through configuration. Unit tests cover the production rejection path and assert that the shipped config stays within the launch catalog. Fixture servers are permitted only under `NODE_ENV=test`.

The pinned Context7 MCP server makes outbound requests to Context7's documentation API when its tools are called. Its source also initializes OpenTelemetry instrumentation; in this stdio configuration it exposes no metrics listener and no exporter is configured, so the reviewed path records local metrics rather than sending telemetry to a third party. This is distinct from a model-provider call. Recheck this behavior against the exact package source on every version change. The official source references are [Context7 MCP v4.3.0](https://github.com/upstash/context7/tree/%40upstash%2Fcontext7-mcp%40v4.3.0/packages/mcp), [Sequential Thinking v1.0.0](https://github.com/modelcontextprotocol/servers/tree/%40modelcontextprotocol%2Fserver-sequential-thinking%401.0.0/src/sequentialthinking), and [Filesystem v1.0.0](https://github.com/modelcontextprotocol/servers/tree/%40modelcontextprotocol%2Fserver-filesystem%401.0.0/src/filesystem). The filesystem server can modify only the one directory passed in its fixed arguments. The pinned arXiv source review is recorded below.

This raises the bar for new servers: source review, exact package pin, minimal launch identity and tests must land together before a production entry is accepted. It still does not provide per-process network isolation. The declaration scan and source review cannot prove that a compromised or malicious pinned release has no hidden provider call. L1.2 remains open until an enforceable egress boundary closes that gap.

## arXiv MCP review (2026-10-11)

The selected package is `arxiv-mcp-server==0.8.2` from PyPI, Apache-2.0, released 2026-10-08. PyPI publishes the wheel SHA-256 `11cb0f60064242028c823ffc78825774340cec644bfb26eaa2917d8d45eb32f7`; the repository requires Python >=3.11 and has a current security policy. The stdio process is installed in its own Python environment, runs under NOVA's unprivileged user, and stores downloaded papers under `/data/arxiv`. No API key is required for basic arXiv search/read. `citation_graph` optionally contacts Semantic Scholar and has unauthenticated rate limits; no key is configured. Base install excludes PDF and local semantic-search extras. Search/read metadata tools are read-only; all other tools remain CONFIRM by default and `unwatch_topic` is DANGEROUS. The server advertises `semantic_search` and `reindex` even without the `[pro]` extra; NOVA disables both explicitly so neither a local model nor model download is exposed. The entry is disabled until enabled in NOVA settings. The source declares seven research prompts, but NOVA's MCP hub does not expose prompts or invoke another model. Review references: [PyPI package and release](https://pypi.org/project/arxiv-mcp-server/), [upstream README/tool list](https://github.com/blazickjp/arxiv-mcp-server), [upstream security policy](https://github.com/blazickjp/arxiv-mcp-server/blob/main/SECURITY.md), and [upstream dependency manifest](https://github.com/blazickjp/arxiv-mcp-server/blob/main/pyproject.toml). The image installs the package; telemetry terms were searched in its installed source with no matches. An MCP handshake listed 19 tools; provider guard accepted declarations and NOVA's config disables semantic embedding tools. No external search API was called.

## CalDAV MCP review (2026-10-11)

`@ni-c/caldav-mcp@0.1.4` is pinned from npm with a committed lockfile; reviewed upstream tag commit `02a668f963a9d114b7fbc9f23505653c6c81a2dd`, MIT. It uses Basic or Bearer auth, removes auth variables from its own environment after parsing, requires TLS by default, and rejects non-loopback plaintext unless explicitly overridden. Authenticated requests stay on the configured origin; server-provided hrefs are checked before use and redirects are rejected or constrained to same-origin discovery. Source inspection found no telemetry or AI/provider calls; this was not a CVE audit. The API key/password never enters NOVA's MCP JSON, audit, status or confirmation payload. The exact reviewed identity passes only references to the private deployment environment.

The catalog entry is disabled when added. Its immutable environment fixes `CALDAV_READ_ONLY=true` and an allowlist of `list_calendars`, `list_events`, `get_event`, `search_events`, and `get_free_busy`; write tools are not registered. All five receive explicit READ_ONLY risk. The image installs dependencies from `deploy/mcp-servers/caldav/package-lock.json`; credentials must stay in the deployment's ignored `.env`, never in Git. The server is optional and the existing native `calendar_events` tool remains available. The user confirmed that ordinary chat may route agenda-derived answers through OmniRoute; this permission does not place credentials in prompts, logs or repository files.

Source: [exact v0.1.4 package README](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/README.md), [configuration](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/config.ts), [HTTP client](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/api.ts), [tool catalogue](https://github.com/ni-c/caldav-mcp/blob/v0.1.4/src/tools/catalogue.ts), [npm package](https://www.npmjs.com/package/%40ni-c/caldav-mcp).

## IMAP MCP review (2026-10-11)

`@ni-c/imap-mcp@0.5.2` is pinned from npm with a committed lockfile, MIT license, Node 22+ requirement, and published integrity `sha512-BgkSvPXCNpi/+miu/gBIZPvL5Cviz0LYI9bSUwFOSe7tJLpcg0PjieEGlyCepzYde2cDMjcD2fSxfHfhNjATjA==`. The npm package points to `ni-c/imap-mcp`; the upstream repository shows 96 commits but only three stars and no GitHub release. This is a narrow source/configuration review, not an independent security audit. The pinned tarball contains no SMTP client or provider/model API call path; mailbox connections use IMAPFlow. TLS is fixed to implicit TLS on port 993, certificate validation stays enabled, and the insecure-TLS option is not passed.

NOVA's exact process identity passes only private `IMAP_HOST`, `IMAP_USER`, and `IMAP_PASSWORD` references. The catalog adds it disabled. Its immutable environment sets `IMAP_READ_ONLY=true`, `IMAP_SEEN_KEYWORD=""`, and `IMAP_ALLOW_TOOLS=list_messages,get_message`. The allowlist excludes `list_new_messages` (which writes an IMAP keyword), attachment access, and every mailbox write tool. The server's attachment resources are also not forwarded by NOVA's MCP hub. Both exposed tools use read-only mailbox access and `BODY.PEEK`; NOVA wraps all returned MCP text as untrusted content before it reaches the model. For user-facing mail summaries, NOVA instructs the model to return sender, subject and a short gist, without quoting the body or following embedded instructions; no outgoing-mail tool is available. Values entered in Settings are stored separately in local `mcp-secrets.json` with mode 0600; deployment `.env` remains an optional initial value source. Neither config, status responses, audit nor confirmations contain those values. No mailbox contents were fetched during package review.

CalDAV and IMAP environment values can be replaced or cleared in PIN-protected Settings. The API accepts only the three fixed field names for each reviewed server; values never return to the browser, blank replacements preserve existing values, and clear is explicit. An enabled process is refreshed after a save. CalDAV addresses must be HTTPS and cannot embed credentials; IMAP accepts a DNS hostname only. This is bounded configuration support, not arbitrary MCP environment editing.

The exact npm package, lockfile audit, TLS reachability check for the user's configured mail host, and read-only MCP handshake/tool list were verified locally. The real mailbox has not been queried. Source: [npm package and pinned integrity](https://www.npmjs.com/package/%40ni-c/imap-mcp), [upstream source and security notes](https://github.com/ni-c/imap-mcp), [upstream tool catalogue](https://github.com/ni-c/imap-mcp/blob/main/src/tools/catalogue.ts), [IMAP read tools](https://github.com/ni-c/imap-mcp/blob/main/src/tools/read.ts), and [RFC 9051 §6.4](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4).

## GitHub MCP review (2026-10-11)

The optional GitHub connector uses the official `github/github-mcp-server` v2.0.2 release (MIT, signed tag commit `eb47a99ddb866ca2b8a162920e6bda9521f33ebb`). The Linux x86_64 and arm64 release archives are checked against upstream's published SHA-256 checksums in the image build; the binary is not downloaded at runtime. The local handshake was run without credentials and made no GitHub API request. Exact-tag source scan found in-process field-selection counters called “telemetry” but no analytics transport or tracking endpoint; repository API traffic is the expected service behavior, not telemetry.

NOVA's fixed launch uses `--read-only`, only `issues,pull_requests,actions`, and an explicit six-tool allowlist: list/read issues, list/read pull requests, and list/read Actions runs. Code contents, job logs, search, and every mutation tool are not exposed. The application additionally filters the advertised tool list and checks the owner/repository arguments against its saved target before every call. The official server documents that read-only mode suppresses mutation tools even when requested, but it does not restrict the underlying token's access. Therefore Settings accepts only a fine-grained `github_pat_` token plus one owner/repository; these values stay in the private 0600 MCP secret store, and only owner/repository labels are returned to the PIN-protected screen. No classic PAT or deployment-environment fallback is accepted. Configure the PAT for only this repository with read-only Metadata, Issues, Pull requests and Actions permissions; GitHub remains off until the user adds and enables it. The API may contact GitHub for the requested repo data; no model-provider endpoint is configured by this server. MCP process egress is not isolated, so L1.2 remains partial. Tool text passes both general sanitization and exact redaction for privately stored MCP credentials before reaching model context.

The pinned `v2.0.2` [server configuration guide](https://github.com/github/github-mcp-server/blob/v2.0.2/docs/server-configuration.md) documents `--read-only` as a strict filter over write tools and separately warns that it does not narrow token authorization. The [immutable v2.0.2 release](https://github.com/github/github-mcp-server/releases/tag/v2.0.2) publishes the architecture archives and checksum file. This is a narrow config and behavior review, not a source-code security audit. No PAT was entered and no live repository was queried.
