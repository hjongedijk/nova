# Embedded Node-RED editor

Open **Settings → Connections → Node-RED → Floweditor → Editor openen** to edit flows inside NOVA. Opening is explicit; closing the editor or leaving the settings section revokes its session and closes its WebSocket connections. Reloading the editor does not deploy changes. Use Node-RED's **Deploy** button to save flow changes.

NOVA connects to the existing local `NODE_RED_URL` and uses `NODE_RED_ADMIN_TOKEN` on the server. The browser receives neither that token nor the private upstream address. No additional published Node-RED port or `NODE_RED_EDITOR_URL` is needed for the embedded editor. The optional external editor link remains available separately.

The editor requires HTTPS and protected NOVA access: either `NOVA_APP_TOKEN` or an authenticated reverse proxy declared with `NOVA_REVERSE_PROXY_AUTH=true`. The latter does not enable NOVA's extra unlock screen. HTTP on localhost is supported for development and isolated tests. Opening also uses the existing settings PIN when one is configured. A separate, HttpOnly, Secure, same-origin editor cookie expires after 30 minutes and is renewed every five minutes while the editor is open; renewal does not ask for the settings PIN again.

The proxy supports the native core flow editor: flow loading, editing and deployment, debug messages, context, library entries, and core node configuration routes. It restricts requests to this protocol. Native login, palette installation, projects, SSH keys, diagnostics and arbitrary runtime HTTP endpoints are not exposed. Manage allowed node packages through NOVA's existing **Nodes** controls. Custom nodes that require their own admin endpoints need an explicit reviewed route addition.

The bridge does not change Node-RED's admin/runtime roots, settings, credentials, seed flows or persistent data. Native assets are forwarded without the private bearer; approved admin requests and authenticated WebSocket handshakes receive it on the server. Browser cookies and authorization headers are never forwarded upstream. Native upstream error bodies are replaced with fixed messages.

## Verification

Run focused tests with:

```sh
npm run test -w @nova/api -- test/settings/node-red-editor-access.test.ts test/settings/node-red-editor-policy.test.ts test/settings/node-red-editor-controller.test.ts test/settings/node-red-editor-proxy.test.ts test/settings/node-red-editor-websocket.test.ts
```

The runtime check requires built API output, an already installed Node-RED Docker image, and Playwright Chromium:

```sh
npm run build -w @nova/api
npm run test:node-red-editor:runtime
```

It starts its own isolated, temporary Node-RED instance on loopback. It verifies native editor loading, authenticated comms, deployment of a synthetic flow, renewal and revocation. It never deploys flows to the production instance.
