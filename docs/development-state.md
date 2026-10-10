# Development checkpoint

Read this checkpoint before exploring the repository again. The task list remains the source of truth.
Check changed files against Git; this map is navigation, not proof that old code still behaves the same.
Do not record credentials, personal messages or actual deployment configuration here.

## Current work

- Task file: `tasks-09-10-2026.md`. Order: A → J (except J4) → K → L → B → C/J4 → D/E/F/G/H/I.
- Phase A: 34/41 complete, commit `fbcad59`. Seven items await Windows testing or later features; see its checkpoint.
- User approved push/release of A, then immediate work on J. Future phase releases still require their phase approval.
- Phase A tags v0.1.9/v0.1.10 published agent assets, but Docker Hub throttling/timeouts prevented image publishing.
- Commit `3534257` configures Docker's registry mirror for QEMU, BuildKit and base-image pulls; v0.1.11 succeeded: CI/release green, amd64/arm64 image and both release assets verified.
- Phase J in progress: 50/259 tasks overall; settings block `81ceebe` verified; private model metrics and explicit release checks also built and tested.
- This file must be updated with test outcomes and the next unfinished step before a usage-limit pause.
- Resume automatically when the host allows execution; this file cannot restart an ended session or increase quota.

## Reusable map

- UI/settings fields and persistence: `docs/settings-inventory.md`.
- Environment/service consumers and restart requirements: `docs/settings-services-inventory.md`.
- Settings route: `apps/web/src/routes/settings/+page.svelte`; catalogue: `components/settings/sections.ts`.
- Existing settings components and state: `apps/web/src/components/settings/`.
- Integration/provider/gateway/memory/audit content: `components/admin/AdminDialog.svelte`, with embedded mode.
- Settings validation, auditing and backup/import: `apps/api/src/settings/settings.controller.ts`.
- Atomic settings file: `apps/api/src/settings/store/settings.store.ts` (0600).
- Guard: `apps/api/src/settings/settings.guard.ts`; browser credential: `apps/web/src/lib/api/pin-session.ts`.
- Runtime configuration: `apps/api/src/core/config/nova-config.ts`; service adapters must account for constructor caches.
- Free routing: `apps/api/src/routing/`; never bypass its fail-closed verification.

## Verification

Phase A: 272 tests; format/lint/typecheck/build; Docker PowerShell; helper browser checks at 1x/2x on dev and local production.
Run Node checks with Node 24 (host Node 22 is below the repository engine requirement).
Use `scripts/check-helper.mjs`; its fixtures contain test data only.
PowerShell syntax/geometry checks do not prove Windows kiosk/tray/audio/display behavior.

Phase J latest block: 498 tests in 40 files; format/lint/typecheck/build passed in Node 24 Docker.
Production settings browser checks passed for all sections, search/keyboard/deep links, mobile, save, PIN expiry/lock, model measurements and explicit release checks.
Production helper regression checks passed at 1x/2x. Screenshots use fixtures; no real phone proof.

Next: J3 account/policy management using `docs/omniroute-admin-api.md`; onboarding follows its policy wizard. Mode updates must verify persisted SQLite values, not the upstream echo or cached registry. J7 personal changes are implemented; night mode and model changes await their owning features.
J2.3 restart button, complete history/backup and service-specific management remain unfinished. J4 waits for C.
Service config: `core/config/service-connections.ts`; store/adapter/controller: `settings/services/`.
Saved gateway URL changes are blocked until provenance is verified; connection tests never establish free billing.
Do not push/release J until its phase approval. No Windows code changed in this block.

Helper preferences and saved mode/display are now included in version-one settings backups. Legacy files preserve omitted helper fields in both merge and replace. Strict nested validation and secret projection cover cues and known wardrobe fields; unrecognized legacy wardrobe extras are omitted from public reads and exports. Import reports helper changes and never commands the Windows agent. Node24 format/lint/typecheck/test/build passed: 1,012 tests in 49 files. Production browser checks passed; local commit `a1622fb`.

J6.2 MQTT overview now lists fixed publisher topics, connection state and at most 50 process-local send summaries behind SettingsGuard. Timer, alert and conversation content stays hidden; delivery callbacks report client acceptance, not broker receipt. No inbound subscription was added. Full Node24 gates passed: 1,015 tests in 50 files, format, lint, typecheck and build. Production browser checks passed at 1x/2x/mobile, including duplicate timestamps; connection and MQTT screenshots reviewed. Continue J; no J push/release approval.

J6.1 Qdrant now has an explicit PIN-guarded read-only overview for up to 20 safe collection names, point/index counts, segment counts and collection status. Names and counts are projected; no points are read, no writes occur, and the key stays server-side. Unsupported names or excess collections set the truncation notice. It does not report byte size or implement memory checks, cleanup or reindexing, so J6.1 remains partial. Full Node24 gates passed: 1,017 tests in 50 files, format, lint, typecheck and build. Production browser checks passed at 1x/2x/mobile with explicit-load behavior; screenshots reviewed.

## Memory tooling decision

Claude-Mem supports Codex and stores/retrieves session observations, but its current installer also offers hosted memory
and AI observation providers. No install was performed. For now, reuse this local checkpoint and the inventory.
Any later installation needs a confirmed local capture/recall path and bounded observation cost; it must not capture secrets.
Upstream inspected 2026-10-09: https://github.com/thedotmack/claude-mem.

Private model observations: `routing/model-metrics.service.ts`; captured by `chat/omniroute-client.service.ts`.
Release metadata: `settings/updates.service.ts` and controller; no automatic network access or installation.
Management responses capped at 2 MB, raw documentation at 16,000 characters; session resets on reconfiguration.
SQLite fixtures prove verified routing and drift rejection. Test workers use 50% CPU: full default-concurrency run
had five unrelated five-second timeouts; four-worker and updated standard runs passed all 373 tests.

Latest checked block: private Windows status and shortcut management in Apparaten. 381 Node24 tests/gates green;
production settings and helper browser tests pass at 1x/2x/mobile. New device screenshots use fixture data only.
No PowerShell/agent source changed; native PC behavior remains unverified.

Latest block: J7 persona replacement, instruction creation/toggle and credential-header boundary. 417 tests in 37 files and all Node24 gates passed; four additional renewal-handler tests passed after review. Production settings/helper browser checks passed, including fresh personal confirmation without “Altijd”. Shared mutations committed as `507aacd`; this feature block follows it locally. Pending confirmations whose configuration changed are cancelled with an explicit request to retry. J7 checkboxes remain partial for future night/model and code/MCP boundaries. No push/release authorized for J.

Latest J3 visibility block: `settings/native-gateway.controller.ts`, `NativeGateway.svelte`, shared `contracts/omniroute.ts`. Explicit fixed management reads expose NOVA/global skill metadata, separate documentation and global prompt enabled/size only. Other owners, handlers, schemas and prompt contents stay private. 31 boundary/API tests added; gateway origin/CSRF and native cache behavior researched against v3.8.51. Native mutations remain pending.

The first 452-test runs hit chat/SQLite setup time-outs. SQLite fixture setup inserted each row in its own transaction; batching setup into one atomic transaction preserved real read-only database checks. Standard test run then passed all 452 without increasing time-outs or reducing worker settings. Gates and build passed; final production native-overview browser checks passed at 1x/2x/mobile, including escaped documentation. Screenshots reviewed. Only new native screenshots should be committed, not regenerated unrelated fixtures.

Native NOVA-owned skill modes are implemented in `settings/native-skill-modes.service.ts` and its guarded controller. Prepare is read-only; confirmation sessions are server-created, 60 seconds and single-use. On/auto are DANGEROUS, off is CONFIRM; no standing approval or chat setter. Global/foreign owners are blocked. Private revisions bind handler/schema/name/owner/mode/update time; per-skill in-flight guards prevent overlapping writes. Read-only SQLite verifies persistence, with honest unknown results and post-audit warnings.

This block added 46 focused tests. All 498 tests in 40 files and Node24 format/lint/typecheck/build passed. Production settings checks passed at 1x/2x/mobile for preparation, cancellation, expiry and confirmed persistence; mobile overview/confirmation screenshots reviewed. No live gateway writes or PowerShell changes. J3.4 stays partial pending prompt editing and further native management. Local commit `561b586`; J push/release remains unauthorized.

Next prompt-editor requirement: pinned upstream PUT replaces the whole stored `settings/systemPrompt` object but merges runtime fields. Send a complete enabled/prefix/suffix payload; GET alone cannot prove persistence. The dedicated endpoint has no atomic CAS support. Use private row revision plus fresh DANGEROUS confirmation and local in-flight guard, verify SQLite after writing, keep prompt drafts/revisions outside public/audited confirmation args, reject recognized secrets and acknowledge all gateway clients. See the new persistence section in `docs/omniroute-admin-api.md`. No prompt writes were performed.

Global prompt replacement is now implemented and reviewed: guarded prepare/confirm, full enabled/prefix/suffix payload, private bounded drafts, autonomous 60-second disposal, no standing approval, SQLite revision and persisted/runtime verification. Production browser checks passed for cancellation, expiry, read-only preparation and full replacement; three prompt confirmation screenshots reviewed, including mobile. Existing prompt contents never enter browser/audit.

Node24 format/lint/typecheck passed. Full tests first had unrelated five-second timeouts (native modes, PDF and MCP); batching mode fixture schema/inserts alone did not resolve them. Running fixtures on Docker tmpfs passed 584 tests (one account HTTP guard temporarily skipped pending registration). The committed prompt/routing subset contains 555 tests; 29 additional account inventory unit tests are uncommitted. Test timeouts and default worker settings were preserved. Web/API build passed. No live gateway writes or agent changes.

Restricted routing now verifies each allowed connection exists and is active in native provider_connections with a verified provider. Missing inventory blocks. This does not yet bind account credentials or fresh billing evidence; mutable account management must invalidate inference before changes. Next: wire safe account/catalog inventory into settings, enable its HTTP guard test, then implement account/policy mutation boundaries. Continue through phase J; do not end a turn solely because a coherent block completed.

Account/catalog inventory is wired into Models with an explicit button and private PIN guard. Fixed GET endpoints project names, provider/model identifiers, enabled state, credential presence and catalog token counts only; billing remains explicitly unverified. Thirty tests include public isolation and PIN boundaries. All 585 tests in 42 files and Node24 format/lint/typecheck/build passed with temporary fixtures on tmpfs. Production browser checks passed at 1x/2x/mobile, proving no automatic fetch and escaped catalog text; account screenshots reviewed. New account mutation work starts with a persistent inference barrier; inventory does not mutate anything.

Pinned create-provider API cannot guarantee a disabled/no-probe account: it unconditionally tests and can activate asynchronously, even with initial inactive storage. The API has no skip-test field; skip-model-sync affects discovery only. Deletion removes related models/routing metadata and can fail after persistence when cloud sync fails. Key restrictions and settings CAS require independent SQLite verification; no shared cross-resource transaction exists. See the account mutation section in the management API research.

Account removal is implemented with a full-effects acknowledgement and fresh DANGEROUS 60-second single-use confirmation. SQLite metadata revisions prevent stale approval, prepare is read-only and no model tool exists. A shared exclusive management operation writes/fsyncs a 0600 persistent marker before DELETE. Routing blocks on marker existence/stat errors and retains an in-memory stop through compound marker-removal/restoration failures. Ownership rejects overlaps and stale controls. Independent row absence proves deletion; only fresh actual free-policy verification permits durable marker removal. Unknown upstream outcomes retain the stop and explicitly warn that deletion may already have happened.

Forty-one deletion and 27 barrier tests plus seven routing marker regressions bring the full Node24 suite to 660 tests in 44 files. Format/lint/typecheck/test/build all passed. Production browser checks passed at 1x/2x/mobile for acknowledgement, no early write, cancel, expiry, confirmed deletion, blocked-route messaging and a delayed-inventory reload race fixed by disabling selection while loading. Removal mobile screenshot reviewed. No actual account writes, provider probes or agent changes. This remains local J work; no phase release approval.

Free-policy wizard now implemented locally: explicit metadata choices, signed ten-minute inventory binding, required operator account/billing/hard-stop/terms attestations, one account per provider, maximum 20 models, official source URL validation without network fetch, fresh 60-second DANGEROUS confirmation. Changing choices clears attestations. The economic evidence source is operator-account; native quota is explicitly unverified. Candidate inspection checks selected account/model structure only, because native strict verdicts are pooled and quota caches are connection-ID based, not credential-bound. Native strict remains enabled. No claim of remaining quota or independent verification of the supplied source/account billing.

Before writes, the durable management barrier blocks inference. Native settings use expectedRevision CAS; NOVA's own key is restricted to auto and selected accounts. Independent SQLite verifies settings, restrictions, credential fingerprints and exclusions. Only then is the private policy atomically replaced with a staged 0600 prior-policy backup and fresh actual routing verification. Unknown or partial outcomes retain the stop. New policies bind account ID/provider/authentication type/current credential; observed rotation blocks every dispatch. Independent external administrators can still race between checks; no cross-resource upstream transaction exists.

Wizard review fixed three issues: old attestations surviving pre-prepare credential rotation (signed options binding), partial final backup publication (stage/fsync/link/publish), and acknowledgements surviving selection changes (reset on add/remove). Focused wizard coverage: 69 tests including token expiry/tamper/drift, cancellation, unknown writes, persistence, partial backup failure/retry and post-audit warnings. Routing binding adds 14 tests; pure planner adds 71 tests. Full Node24 format/lint/typecheck/test/build gates passed: 814 tests in 46 files on tmpfs. Production browser checks passed at 1x/2x/mobile for explicit reads, escaped labels, no early writes, cancellation, expiry and confirmed configuration; mobile screenshot reviewed. Selection-reset browser regressions passed for both add and remove. J3.2 is complete with the stated operator evidence limits. No actual gateway writes or provider probes were performed by the coding agent.

Next J block: J2.5 backup preview and expanded coverage. Existing import writes without a separate preview and BackupSection has no file-size bound. Inspect current contracts/controller/tests before extending; never export secret values, standing approval grants or provider credentials. Service/flow backup remains separate until owners support a safe format. Continue phase J; do not stop solely at a block boundary, and do not push/release J without phase approval.

Backup import block implemented and reviewed: `settings/backup-plan.ts` validates a detached, bounded v1 candidate before writing; `settings/settings-backup.service.ts` holds at most 20 private 60-second candidates bound to current settings. Guarded POST `/settings/import/prepare` returns nonsecret counts/changed categories plus DANGEROUS single-use confirmation; `/settings/import` now consumes that confirmation only. Direct legacy payloads cannot write. UI reads files only up to 1 MB, freezes selection during review, exposes removals and missing secret names, and supports cancel/expiry. New declared secret values are stripped; existing private headers survive merge only at the same URL/method with matching declared names. Known or recognized secrets across the whole public candidate (including keys and forward references) reject preparation. No grants or service credentials can be imported.

Review fixed a potential secret leak through ordinary imported fields and duplicate-name keys in the summary UI. Pure builder has 62 tests, approval/HTTP service 44 tests; existing API round trips were migrated to prepare/confirm without weakening privacy. Full Node24 format/lint/typecheck/test/build gates passed: 920 tests in 48 files with fixtures on tmpfs. Production settings browser checks passed at 1x/2x/mobile for oversized files before read/network, invalid JSON, preview-only preparation, frozen fields, acknowledgement, cancellation, expiry, successful application and duplicate escaped labels. Mobile import screenshot reviewed. No agent source or real Windows/phone tests in this block. J2.5 stays partial pending other owners and helper state.

Next: J5.2 bounded private tool-usage statistics in the tools overview, using existing audit data and existing standing approvals. Count terminal execution records once, do not count preparation/start/confirmation events, return no arguments, results or session IDs. Scope UI states the bounded history and excludes quiet dashboard actions that are intentionally not audited. Continue phase J; no J push/release permission yet.

J5.2 tool statistics implemented and reviewed: guarded `settings/tool-usage.controller.ts` projects at most 500 current-tool metadata rows and scans at most 500 entries from the existing 2 MB audit tail. It counts only terminal result records (valid timestamp/duration/boolean result), excludes preparation/start/permission events, groups callers into fixed non-identifying contexts, returns no raw arguments/results/session IDs and invokes no tools. UI loads explicitly, states coverage and OK-result limitations, supports filtering and unused rows, and reuses existing permanent-permission revocation in Vaardigheden.

Forty-seven focused tests and review passed. Full Node24 format/lint/typecheck/test/build gates passed: 967 tests in 49 files on tmpfs. Production settings browser checks passed at 1x/2x/mobile for explicit reads, bounded history, source/name filters, unused rows, escaped sources, absent raw private fields, current permissions, touch size and no overflow. Mobile screenshot reviewed. No actual tool calls or agent source changes. J5.2 complete; caller buckets are contexts, not personal identities.

J5.1 now includes a PIN-guarded explicit version timeline backed by the existing skill version counter and bounded audit tail. It returns only version/action/canonical timestamp metadata, skips malformed audit rows, and caps display at 20 entries. UI cache rejects stale responses and hides history after a version change. No content snapshots or restore; J5.1 remains partial. Full Node24 format/lint/typecheck/test/build passed: 1,017 tests in 50 files. Production settings browser checks passed at 1x/2x/mobile; skill content stayed hidden and fetch occurred only on request. Mobile screenshot reviewed. No skill was run or changed through the UI.

J3.1 now also includes explicit PIN-protected combo-route inventory: at most 200 routes and 100 model references each, projecting only ID/name/display name/active/strategy/model labels. Prompt, config, and credential fields are omitted. Together with provider account/catalog metadata this remains read-only; billing is unverified. Thirty-six focused tests passed; full Node24 format/lint/typecheck/build and 1,023 tests in 50 files passed. Production browser checks passed desktop/2x/mobile; escaped labels and combo details reviewed. No route or gateway setting was changed.

Next J3.1: add only management actions with fresh confirmation, persistent inference barriers, and independent storage verification; account creation is unsafe on the pinned API because it probes and can asynchronously activate. Review safer route/model visibility updates first. Then continue J2.3 restart, J2.4 history and J2.5 complete backups. No phase J push/release approval.

J2.3 controlled restart is implemented for the official Docker Compose deployment only. `NOVA_RESTART_ENABLED` defaults off and is enabled in `deploy/docker-compose.yml`, where `restart: unless-stopped` supervises the process. The guarded endpoint requires pending restart changes, writes an audit record and sends SIGTERM after replying; UI asks first and disables duplicate requests. Other deployment types do not show the restart button. Node24 format/lint/typecheck/build and all 1,025 tests passed; production browser flow passed desktop/2x/mobile and mobile screenshot reviewed. No real container restart was triggered.

Next: J2.4 broaden change history and safe per-change rollback beyond service connections. Preserve secret redaction and conflict checks. Then complete J2.5 coverage for remaining owners. Continue J; no push/release approval.

J2.4 now records private helper preferences, tool switches and sidebar layout (history files 0600, bounded to 100 revisions with 50 shown). Helper snapshots use the validated preference shape. Tool snapshots contain only names and effective booleans; sidebar snapshots contain only panel layout and visibility, never widget content, prompts or source URLs. Rollbacks compare current values before writing. PIN-protected System history loads only on request. Ten focused tests cover private storage, bounded retention, rollback and stale conflicts. Full Node24 format/lint/typecheck/build passed; all 1,036 tests passed with one worker after the parallel run hit unrelated 5-second timeouts under load. Production browser history/rollback passed at desktop/2x/mobile; sidebar mobile screenshot reviewed. J2.4 remains partial. No agent command or tool execution occurred.

Next J2.5: extend reviewed import/export coverage to safe model/service/flow/list owners; keep credentials, approval grants and sensitive service data excluded. Continue phase J; no push/release approval.

J2.5 ownership review: quick actions and widgets (including list panels) are already in the local v1 backup. Node-RED flows have no NOVA-owned API/store yet; C1/C2 and J4 establish that owner. Service and provider/model configuration includes sensitive upstream-owned values and is not safe to import as part of this local file. Updated `docs/configuration.md` to state these boundaries and current histories. No format or runtime behavior changed in this docs block.
