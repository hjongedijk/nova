# Development

## Requirements

- Node 24 or newer (`.nvmrc` says `24`; `engines` in `package.json` is `>=24`) and npm 10.
- Docker, for the services NOVA talks to (OmniRoute, MQTT, Qdrant).
- Optional: PowerShell 7 (`pwsh`) to run the Windows agent check locally.

## Set up

```sh
cp .env.example .env                              # fill in the keys you have
docker compose -f docker-compose.dev.yml up -d    # OmniRoute, MQTT, Qdrant
npm install
set -a; . ./.env; set +a                          # NOVA does not read .env itself: export it
npm run dev                                       # API on :3000, web on :5173 (proxies /api)
```

NOVA reads only real environment variables; it does not load a `.env` file. In production Docker Compose passes `.env` in. In development, export the file into your shell as above (or set the variables you need inline) before `npm run dev`.

The development compose file (`docker-compose.dev.yml`) starts only what NOVA talks to: OmniRoute (port 20128, data in `dev-data/omniroute`), Mosquitto without authentication (1883), Qdrant (6333, data in `dev-data/qdrant`) and, under the profile `node-red`, Node-RED (1880): `docker compose -f docker-compose.dev.yml --profile node-red up -d`. Home Assistant is not included; point `HOME_ASSISTANT_URL` at yours.

NOVA itself runs on the host with `npm run dev`. Outside Docker the API still defaults to the compose service names (`http://omniroute:20128/v1`, `mqtt://mqtt:1883`, `http://qdrant:6333`), which do not resolve on the host, so set `OMNIROUTE_URL`, `MQTT_URL`, `QDRANT_URL` and `OMNIROUTE_DATABASE` to the published ports (for example `http://localhost:20128/v1`, `mqtt://localhost:1883`, `http://localhost:6333` and `./dev-data/omniroute/storage.sqlite`). Without them NOVA still starts; the corresponding features report themselves unavailable.

## Ports and runtime data

| What               | Port | Notes                                                                             |
| ------------------ | ---- | --------------------------------------------------------------------------------- |
| API (NestJS watch) | 3000 | `PORT` default outside the image.                                                 |
| Web (Vite)         | 5173 | Fixed (`strictPort`), reachable from the LAN, proxies `/api` to `localhost:3000`. |

All runtime data goes to `dev-data/` (ignored by git). If `dev-data/certs/cert.pem` and `key.pem` exist (or `NOVA_DEV_CERT_DIR` points at such a folder) the Vite server uses HTTPS, which the microphone needs on another machine. Create a self-signed pair with `openssl` as shown in [Getting started](getting-started.md#7-https-the-microphone-and-installing-as-an-app).

`npm run dev:background` starts everything detached with a log in `dev-data/dev.log` and prints the URL; `npm run dev:stop` stops it.

## Commands

| Command                  | Does                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `npm run dev`            | API (watch) and web (Vite) side by side                         |
| `npm test`               | API tests (Vitest)                                              |
| `npm run lint`           | ESLint over the repository (flat config, TypeScript and Svelte) |
| `npm run typecheck`      | `tsc` for contracts and API, `svelte-check` for the web app     |
| `npm run format`         | Prettier, writing                                               |
| `npm run format:check`   | Prettier, checking (what CI runs)                               |
| `npm run build`          | Web (`apps/web/build`), then API (`apps/api/dist`)              |
| `npm start`              | Run the built API (it serves `apps/web/build` when present)     |
| `docker build -t nova .` | The production image                                            |

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, `test`, `build` and `pwsh -NoProfile -File agents/windows/test/check.ps1`, and builds the image without pushing it, on every push to `main` and every pull request. Run the same before you push.

## Tests

- API tests live in `apps/api/test/<module>/` and run with `npm test`, or `cd apps/api && npx vitest run test/<module>` for one module. They use fakes for Home Assistant, MCP servers and the Windows agent; no external service is needed.
- The Windows agent has only a syntax and C# compile check (`agents/windows/test/check.ps1`).
- There is no end-to-end suite for the web interface.

## Adding a tool

A tool source is a class implementing `ToolSource` (`apps/api/src/tools/tool.types.ts`), marked with `@ToolSourceProvider()` and registered as a provider in its module. The registry finds it by itself.

- `source`: a short id shown in settings.
- `definitions()`: name, an English description for the model, JSON-schema `parameters` (helpers `schema`, `text`, `integer`, `number`), `risk` (`READ_ONLY`, `SAFE`, `CONFIRM`, `DANGEROUS`), optional `timeoutMs` and `enabled: false` when not configured.
- `prepare()` (optional): decide the real risk or adjust arguments for this call.
- `execute()`: do it and return `{ ok, result?, error?, verified? }`. Do not throw for expected failures.

Sources never ask for confirmation themselves; `ToolsService` does. Use `sanitize()` on anything that could hold secrets, `core/security` for outbound requests to addresses the model chose, and add a field to `NovaConfig` instead of reading `process.env`. See `apps/api/test/tools/tools.service.test.ts` for a complete example, and [Tools and safety](tools-and-safety.md).

## Editor setup

Open the repository root in VS Code, run `npm install` and install the workspace recommendations (Extensions, `@recommended`; see `.vscode/extensions.json`): Svelte, ESLint, Prettier, EditorConfig, PowerShell, Container Tools, YAML, a docstring helper and Claude Code. The workspace settings format on save, apply ESLint fixes on explicit saves, use the Svelte extension to format Svelte files and Prettier for the rest, and exclude generated output and `dev-data` from search and file watching. Accept VS Code's prompt to use the workspace TypeScript version.

**Terminal, Run Task** offers dev, build, test, lint, typecheck and format-check tasks, which reuse the npm scripts; **Ctrl+Shift+B** runs the build task.

## Code style

Prettier (`.prettierrc`) and EditorConfig define formatting (PowerShell has its own line-ending rule). `*.ps1` files use CRLF line endings (see `.editorconfig`).
