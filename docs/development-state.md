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
- Phase J in progress: 44/259 tasks overall; standalone settings, navigation/search, preservation, PIN and nine private service connections verified.
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

Phase J first block: 320 tests in 31 files; format/lint/typecheck/build passed in Node 24 Docker.
Production settings browser checks passed for all sections, search/keyboard/deep links, mobile, save, PIN expiry and lock.
Production helper regression checks passed at 1x/2x. Screenshots use fixtures; no real phone proof.

Next: continue J3 OmniRoute management using `docs/omniroute-admin-api.md`; onboarding follows its policy wizard.
J2.3 restart button, complete history/backup and service-specific management remain unfinished. J4 waits for C.
Service config: `core/config/service-connections.ts`; store/adapter/controller: `settings/services/`.
Saved gateway URL changes are blocked until provenance is verified; connection tests never establish free billing.
Do not push/release J until its phase approval. No Windows code changed in this block.

## Memory tooling decision

Claude-Mem supports Codex and stores/retrieves session observations, but its current installer also offers hosted memory
and AI observation providers. No install was performed. For now, reuse this local checkpoint and the inventory.
Any later installation needs a confirmed local capture/recall path and bounded observation cost; it must not capture secrets.
Upstream inspected 2026-10-09: https://github.com/thedotmack/claude-mem.
