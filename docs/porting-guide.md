# Porting guide

NOVA is being rebuilt fresh in NestJS (API) and SvelteKit (web). The running prototype in
`/opt/jarvis` is the **source to port from** (read it, never import it, never run it).
This guide is the contract between the people (and agents) doing the porting.

## What "ported" means

- Same behaviour as the prototype, same HTTP routes and JSON shapes under `/api/...`, so the
  interface and the agents keep working. Dutch user-facing messages stay Dutch and word-for-word
  where the prototype's tests or UI depend on them.
- Written as idiomatic NestJS + TypeScript (strict). No `any` unless unavoidable and commented.
- Tests ported alongside, using Vitest (`apps/api/test/<module>/...test.ts`). Port the intent of the
  prototype's test (`/opt/jarvis/server/test/*.test.js`, `/opt/jarvis/nodered/test/*.cjs`); a
  module is not done without its tests.
- Secrets never reach logs, the model or the browser: run results through `sanitize()`.

## Layout rules

- One folder per module under `apps/api/src/<module>/`, with `<module>.module.ts`.
- A module uses another module only through what it exports (its service). Never import another
  module's internal files, except the shared kernel below.
- The shared kernel (global, inject freely): `NovaConfig`, `AuditService`, `StateService`,
  `MqttService`, `ToolsService`, `ConfirmationsService`, `SessionMemoryService`, `SettingsStore`.
  Plain helpers: `core/security/{sanitize,net-guard,safe-request}.ts`, `core/http/http-json.ts`,
  `core/errors/validation.error.ts` (`ValidationError` -> HTTP 400 `{error, details}`).
- Types shared with the web live in `packages/contracts/src/*.ts` (types only, `import type`).
  Add what the web needs; do not duplicate types in the web app.
- Import relative paths with the `.js` extension (ESM / NodeNext).
- Config comes from `NovaConfig` (add a field there when needed), never `process.env` directly,
  except in tests.

## Tools

Anything that offers tools to the model is a **tool source**: an `@ToolSourceProvider()` class
implementing `ToolSource` (`apps/api/src/tools/tool.types.ts`), registered as a provider in its
module. `ToolsService` finds it by itself. Look at `test/tools/tools.service.test.ts` for a
complete example. A source:

- `source`: short id shown in settings (`proxmox`, `home-assistant`, `windows`, ...).
- `definitions()`: tool name, English description for the model, JSON-schema `parameters`
  (use `schema/text/integer/number` helpers), `risk` (`READ_ONLY | SAFE | CONFIRM | DANGEROUS`),
  optional `timeoutMs`, `enabled: false` when not configured.
- `prepare()` (optional): decide the real risk or adjust arguments for this call.
- `execute()`: do it. Return `{ ok, result?, error?, verified? }`. Never throw for expected failures.
- Risky actions are confirmed by `ToolsService`; sources do not ask for confirmation themselves.

## Testing and checks

From the repo root: `npm test -w @nova/api`, `npm run typecheck -w @nova/api`, `npm run lint`,
`npx prettier --write <your files>`. Run only your own tests while working
(`cd apps/api && npx vitest run test/<module>`); the machine has limited memory, so do not start
several heavy processes at once, and stop anything you started.

## Rules for parallel work

- Touch only your own module folders, your tests, and `packages/contracts/src/<your file>.ts`
  (plus a line in `packages/contracts/src/index.ts`). Do not edit `app.module.ts`: export your
  module class and report its name; the integrator wires it.
- Do not run `git` commands that change state. Do not edit `/opt/jarvis`.

## Web (SvelteKit 3, Svelte 5 runes)

- `apps/web/src/lib/api/*` is the only place that calls `fetch`; components use these functions.
- Shared state in `src/lib/stores/*.svelte.ts` (runes), components in `src/components/<area>/`.
- Imports use `#lib/...` (package.json `imports`), never `$lib`.
- Keep the visual design of the prototype (`/opt/jarvis/web/index.html`): same tokens
  (`src/app.css`), same layout, same Dutch texts, same behaviour. Port it, do not redesign it.

### Page composition (web)

`src/routes/+page.svelte` (owned by the _shell_ work) composes, in this order:
`<Entity/> <Header/> <Column side="left"/> <Column side="right"/> <Stage/> <Composer/> <Toasts/> <Dock/> <HistoryDrawer/> <SettingsDialog/> <AdminDialog/>`.

| Area    | Owns                                                                                                                                                                                                                    | Files                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| shell   | page, layout, entity canvas, voice (speaking, listening, "Hey NOVA", mobile audio unlock), chat/SSE layer, header + menu, composer, chips, stage, toasts, dock, confirmation cards, history drawer, wallpaper mode, PWA | `routes/*`, `lib/entity/*`, `lib/voice/*`, `lib/chat/*`, `lib/modes/*`, `lib/stores/{chat,chrome,toasts,device}*`, `components/shell/*` |
| hud     | the side columns and every panel                                                                                                                                                                                        | `components/hud/*`, `lib/stores/{dashboard,sidebar}.svelte.ts`, `lib/api/{dashboard,widgets}.ts`                                        |
| dialogs | settings dialog (all tabs), admin dialog                                                                                                                                                                                | `components/settings/*`, `components/admin/*`, `lib/api/{settings,admin}.ts`, `components/ui/*`                                         |

Shared, already present: `lib/api/client.ts` (`getJson`, `sendJson`, `ApiError`), `lib/stores/toasts.svelte.ts`
(`showToast`), `lib/stores/chrome.svelte.ts` (`showChrome`), `lib/stores/chat.svelte.ts` (`chat` state, `ask`),
`lib/stores/dialogs.svelte.ts` (`dialogs.settings/admin/history`), `lib/stores/device.ts`, `lib/util/storage.ts`,
`app.css` tokens. Use them; extend them only in your own area. Anything you need from another area, import
its component or function by the path above; if it does not exist yet, code against the described name and
keep going (the other work lands in parallel).

Verification without the new API: mock `/api/*` with Playwright route handlers using the prototype's response
shapes (see `packages/contracts/src/*.ts` and `/opt/jarvis/web/index.html`). Start `npm run dev -w @nova/web`
on a free port, never leave it running, and use `playwright-core` from the repo's node_modules with the
installed Chromium. Take screenshots and compare them to the prototype's look.
