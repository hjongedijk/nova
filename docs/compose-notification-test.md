# Compose notification integration test

Run `node scripts/test-compose-notification.mjs` (Docker Compose must be
available) to build the API and start an isolated NOVA API, Node-RED, and
Windows-helper mock. A one-shot seeded Node-RED flow sends a token-authenticated
`nova-notify` event to the real API. The test verifies the event in NOVA's alert
feed and verifies NOVA dispatches the same event through the authenticated
helper speech endpoint. Compose volumes and containers are removed afterwards.

The helper is a recording mock, so this proves the speech request reaches the
helper boundary; it does not prove audible playback on a physical Windows PC.
