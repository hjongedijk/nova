# NOVA

A personal AI assistant for home and servers: a living interface that talks, listens ("Hey NOVA"), shows your servers and home on its side panels, and acts on them after your confirmation.

This repository holds NOVA itself. It is released as one Docker image, `ghcr.io/hjongedijk/nova`: the NestJS API and the built Svelte app together. The services NOVA talks to (OmniRoute, MQTT, Qdrant, Home Assistant, optionally Node-RED) run as their own containers, see [`deploy/docker-compose.yml`](deploy/docker-compose.yml).

> Status: the interface and all API modules are ported and tested; what remains is moving the running installation over (data, certificates, timers) and the first release. See [docs/architecture.md](docs/architecture.md).

## Layout

| Path                 | What                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | NestJS backend. One module per domain (chat, tools, settings, dashboard, ...). Serves the web app in production. |
| `apps/web`           | SvelteKit interface, built to static files.                                                                      |
| `packages/contracts` | Types shared by API and web (types only).                                                                        |
| `agents/windows`     | PowerShell agent for the Windows PC: programs, wallpaper per display or a small helper overlay, browser.         |
| `deploy`             | Production `docker-compose.yml`.                                                                                 |
| `docs`               | Architecture and background.                                                                                     |

## Development

Requirements: Node 22, Docker.

```sh
cp .env.example .env                              # fill in the keys you have
docker compose -f docker-compose.dev.yml up -d   # OmniRoute, MQTT, Qdrant
npm install
npm run dev                                       # API on :3000, web on :5173 (proxies /api)
```

| Command                              | Does                                    |
| ------------------------------------ | --------------------------------------- |
| `npm run dev`                        | API (watch) and web (Vite) side by side |
| `npm test`                           | API tests                               |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript and svelte-check    |
| `npm run format`                     | Prettier                                |
| `npm run build`                      | Web, then API                           |
| `docker build -t nova .`             | The production image                    |

Local runtime data goes to `dev-data/` (ignored by git).

## Release

```sh
git tag v1.0.0 && git push --tags
```

GitHub Actions builds and pushes `ghcr.io/hjongedijk/nova:1.0.0` (and `latest`), and attaches the agents as zip files and the production compose file to the release. On the server: set `NOVA_VERSION=1.0.0` in `.env`, then `docker compose pull && docker compose up -d`.

## License

MIT
