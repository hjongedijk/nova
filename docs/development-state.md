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
- Phase J in progress: 47/259 tasks overall; settings block `81ceebe` verified; private model metrics and explicit release checks also built and tested.
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

Next: J3.2 free-policy wizard. Pinned native candidate inspection does not enforce NOVA key restrictions and copies a pooled strict verdict onto every account row. One safe account can mask another unsafe account. A prepared policy must stay unverified/blocked until native eligibility is proven; a singleton logical model pool can support narrow verification, otherwise do not claim per-account proof. Explicit candidate inspection may refresh native quota metadata but never runs model inference; any such request must be explained in the wizard. Canonical exposure IDs use catalog provider/model, not guessed dashboard aliases. Account creation still requires a supported non-inference validation path or an upstream safe-create capability.
