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

Phase J latest block: 381 tests in 35 files; format/lint/typecheck/build passed in Node 24 Docker.
Production settings browser checks passed for all sections, search/keyboard/deep links, mobile, save, PIN expiry/lock, model measurements and explicit release checks.
Production helper regression checks passed at 1x/2x. Screenshots use fixtures; no real phone proof.

Next: continue J3 native OmniRoute management and account/policy management using `docs/omniroute-admin-api.md`; onboarding follows its policy wizard. J7 personal changes are implemented; night mode and model changes await their owning features.
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
