import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContext7Relay } from "./mcp-egress.mjs";
import { createContext7WorkerProxy } from "./mcp-proxy-stdio.mjs";

test(
  "relay starts without capabilities under the documented uid-1000 directory ownership",
  { skip: process.getuid?.() !== 0 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-context7-owner-"));
    fs.chownSync(root, 1000, 1000);
    for (const name of ["mcp-egress-server.mjs", "mcp-egress.mjs"])
      fs.copyFileSync(
        fileURLToPath(new URL(name, import.meta.url)),
        path.join(root, name),
      );
    const directory = path.join(root, "context7");
    fs.mkdirSync(directory, { mode: 0o755 });
    fs.chownSync(directory, 1000, 1000);
    const code = `import fs from 'node:fs'; import {startContext7Relay} from ${JSON.stringify(new URL(`file://${root}/mcp-egress-server.mjs`).href)}; const server=await startContext7Relay(${JSON.stringify(directory)}); console.log(JSON.stringify({uid:process.getuid(),caps:fs.readFileSync('/proc/self/status','utf8').match(/CapEff:\\s*([0-9a-f]+)/)[1]})); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      uid: 1000,
      gid: 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const ready = await Promise.race([
      once(child.stdout, "data").then(([chunk]) =>
        JSON.parse(chunk.toString()),
      ),
      once(child, "exit").then(() => {
        throw new Error(`Relay owner fixture exited: ${stderr}`);
      }),
    ]);
    assert.deepEqual(ready, { uid: 1000, caps: "0000000000000000" });
    assert.equal(
      fs.statSync(path.join(directory, "relay.sock")).mode & 0o777,
      0o660,
    );
    const health = await new Promise((resolve, reject) => {
      http
        .get(
          { socketPath: path.join(directory, "relay.sock"), path: "/health" },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        )
        .on("error", reject);
    });
    assert.equal(health, 200);
  },
);

test("worker loopback reaches only the constrained Unix relay and preserves documentation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-context7-proxy-"));
  const socketPath = path.join(root, "relay.sock");
  const received = [];
  const fixture = http.createServer((request, response) => {
    received.push(request.url);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("TypeScript documentation fixture");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const gateway = createContext7Relay({
    request: (options, callback) => {
      assert.equal(options.hostname, "context7.com");
      assert.equal(options.servername, "context7.com");
      assert.equal(options.rejectUnauthorized, true);
      return http.request(
        {
          hostname: "127.0.0.1",
          port: fixture.address().port,
          path: options.path,
          headers: options.headers,
        },
        callback,
      );
    },
  });
  gateway.listen(socketPath);
  await once(gateway, "listening");
  const worker = createContext7WorkerProxy({ socketPath });
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  t.after(async () => {
    for (const server of [worker, gateway, fixture]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${worker.address().port}`;
  const result = await fetch(
    `${base}/api/v2/context?query=compile&libraryId=%2Fmicrosoft%2Ftypescript`,
  );
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "TypeScript documentation fixture");
  assert.deepEqual(received, [
    "/api/v2/context?query=compile&libraryId=%2Fmicrosoft%2Ftypescript",
  ]);
  const bad = await fetch(`${base}/v1/chat/completions`);
  assert.equal(bad.status, 400);
  const writes = await fetch(
    `${base}/api/v2/context?query=compile&libraryId=demo`,
    { method: "POST", body: "private-provider-request" },
  );
  assert.equal(writes.status, 400);
  assert.equal(received.length, 1);
});
