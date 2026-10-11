import assert from "node:assert/strict";
import http from "node:http";
import { waitForNodeRed } from "./dev.mjs";

const server = http.createServer((_request, response) => {
  response.writeHead(200);
  response.end("ready");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  await waitForNodeRed({
    url: `http://127.0.0.1:${address.port}`,
    timeoutMs: 2_000,
    intervalMs: 10,
  });
  await assert.rejects(
    waitForNodeRed({ url: "http://example.org", timeoutMs: 1 }),
    /must point to a local Node-RED service/,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log("Development readiness checks passed.");
