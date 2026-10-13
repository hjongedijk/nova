import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createContext7Relay } from "./mcp-egress.mjs";

const SEARCH = "/api/v2/libs/search?query=how+to+use&libraryName=react";
const CONTEXT =
  "/api/v2/context?query=fetch&libraryId=%2Fvercel%2Fnext.js&language=en";
const FAILURE = "Context7 upstream unavailable.\n";

async function fixture(
  t,
  serve = (source) => source.end("docs"),
  responseOptions = {},
) {
  const calls = [];
  const server = createContext7Relay({
    request(options, callback) {
      const upstream = new EventEmitter();
      upstream.destroyed = false;
      upstream.destroy = () => {
        upstream.destroyed = true;
      };
      const source = new PassThrough();
      source.statusCode = 200;
      source.headers = { "content-type": "text/plain; charset=utf-8" };
      source.complete = true;
      Object.assign(source, responseOptions);
      upstream.end = () =>
        queueMicrotask(() => {
          callback(source);
          if (!source.destroyed) serve(source, upstream);
        });
      calls.push({ options, upstream, source });
      return upstream;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const send = (path = SEARCH, options = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, ...options },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  return { server, port, calls, send };
}

test("accepted search/docs use fixed HTTPS destination and own headers", async (t) => {
  const { calls, send } = await fixture(t, (source) => {
    source.headers["set-cookie"] = "secret=private";
    source.headers.location = "https://provider.invalid";
    source.end("untrusted documentation https://provider.invalid");
  });
  for (const path of [
    SEARCH,
    CONTEXT,
    "/api/v2/context?query=https%3A%2F%2Fprovider.invalid&libraryId=%2Freact%2Freact",
  ]) {
    const result = await send(path, {
      headers: {
        Host: "provider.invalid",
        Authorization: "Bearer secret",
        Cookie: "secret=1",
        "X-Forwarded-For": "1.2.3.4",
        "Proxy-Authorization": "secret",
        "Accept-Encoding": "gzip",
        "User-Agent": "caller",
      },
    });
    assert.equal(result.status, 200);
    assert.equal(
      result.body,
      "untrusted documentation https://provider.invalid",
    );
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers["content-type"], "text/plain; charset=utf-8");
    assert.deepEqual(calls.at(-1).options, {
      protocol: "https:",
      hostname: "context7.com",
      port: 443,
      servername: "context7.com",
      rejectUnauthorized: true,
      method: "GET",
      path,
      agent: false,
      headers: {
        Host: "context7.com",
        Accept: "application/json, text/plain",
        "User-Agent": "nova-context7-relay",
      },
    });
  }
});

test("invalid targets, route aliases, parameters, methods and bodies never reach upstream", async (t) => {
  const { calls, send } = await fixture(t);
  const invalid = [
    "https://context7.com" + SEARCH,
    "http://provider.invalid" + SEARCH,
    "//provider.invalid" + SEARCH,
    "/api/v2/../v2/context?query=a&libraryId=b",
    "/api/v2/%63ontext?query=a&libraryId=b",
    "/api/v2/context/?query=a&libraryId=b",
    SEARCH + "#fragment",
    SEARCH + "&query=again",
    SEARCH + "&url=https://provider.invalid",
    SEARCH + "&target=provider.invalid",
    SEARCH + "&language=en",
    SEARCH + "&",
    "/api/v2/context?query=a",
    "/api/v2/context?query=&libraryId=b",
    "/api/v2/context?query=a&libraryId=b&language=en&language=fr",
    "/api/v2/context?%71uery=a&libraryId=b",
    "/api/v2/context?query=%zz&libraryId=b",
    "/api/v2/context?query=%0D%0AHost%3Aevil&libraryId=b",
    "/api/v2/context?query=a&libraryId=" + "b".repeat(1025),
    "/api/v2/context?query=a&libraryId=b&language=" + "e".repeat(65),
    "/api/v2/context?query=" + "a".repeat(8193) + "&libraryId=b",
    "/api/v2/context?query=" + "%41".repeat(5500) + "&libraryId=b",
  ];
  for (const path of invalid) {
    assert.equal((await send(path)).status, 400, path.slice(0, 120));
  }
  for (const options of [
    { method: "POST" },
    { headers: { "Content-Length": "1" }, body: "x" },
    { headers: { "Transfer-Encoding": "chunked" }, body: "x" },
  ])
    assert.equal((await send(SEARCH, options)).status, 400);
  assert.equal(calls.length, 0);
});

test("CONNECT and upgrade requests are denied without upstream", async (t) => {
  const { calls, port } = await fixture(t);
  for (const raw of [
    "CONNECT provider.invalid:443 HTTP/1.1\r\nHost: provider.invalid\r\n\r\n",
    `GET ${SEARCH} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  ]) {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.end(raw);
    await once(socket, "close");
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 400 /);
  }
  assert.equal(calls.length, 0);
});

test("upstream errors, redirects, compression, aborted and oversized bodies fail without leaks", async (t) => {
  for (const serve of [
    (source) => source.emit("error", new Error("private diagnostics")),
    (source, upstream) =>
      upstream.emit("error", new Error("private diagnostics")),
    (source) => source.emit("aborted"),
    (source) => source.end(Buffer.alloc(1024 * 1024 + 1, "s")),
  ]) {
    const { send } = await fixture(t, serve);
    const result = await send();
    assert.equal(result.status, 502);
    assert.equal(result.body, FAILURE);
  }
  for (const change of [
    { statusCode: 302 },
    { statusCode: 500 },
    { headers: { "content-encoding": "gzip" } },
  ]) {
    const { send, calls } = await fixture(
      t,
      (source) => source.end("private diagnostics"),
      {
        ...change,
        headers: {
          ...change.headers,
          location: "https://provider.invalid",
          "set-cookie": "secret=1",
        },
      },
    );
    const result = await send();
    assert.equal(result.status, 502);
    assert.equal(result.body, FAILURE);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(calls.length, 1);
  }
});

test("local health has a fixed response and makes no upstream request", async (t) => {
  const { send, calls } = await fixture(t);
  const result = await send("/health");
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  assert.equal(calls.length, 0);
  assert.equal((await send("/health?target=evil")).status, 400);
});

test("exact body cap and bounded content type are accepted", async (t) => {
  const { send } = await fixture(
    t,
    (source) => source.end(Buffer.alloc(1024 * 1024, "d")),
    { headers: { "content-type": "x".repeat(257) } },
  );
  const result = await send();
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1024 * 1024);
  assert.equal(result.headers["content-type"], "application/octet-stream");
});

test("timeout is absolute and client cancellation destroys upstream", async (t) => {
  const { send, calls, port } = await fixture(t, () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = send();
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(result.status, 502);
  assert.equal(result.body, FAILURE);
  assert.equal(calls[0].upstream.destroyed, true);
  t.mock.timers.reset();
  const req = http.get({ hostname: "127.0.0.1", port, path: SEARCH });
  req.on("error", () => {});
  while (calls.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  req.destroy();
  while (!calls[1].upstream.destroyed)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[1].source.destroyed, true);
});

test("four upstream slots saturate and cancellation releases exactly one slot", async (t) => {
  const { send, calls, port } = await fixture(t, () => {});
  const held = Array.from({ length: 4 }, () => {
    const req = http.get({ hostname: "127.0.0.1", port, path: SEARCH });
    req.on("error", () => {});
    return req;
  });
  t.after(() => held.forEach((req) => req.destroy()));
  while (calls.length < 4)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await send()).status, 503);
  assert.equal(calls.length, 4);
  assert.equal((await send("/health")).status, 200);
  held[0].destroy();
  while (!calls[0].upstream.destroyed)
    await new Promise((resolve) => setImmediate(resolve));
  // Repeated terminal signals must not release another held request's slot.
  calls[0].upstream.emit("error", new Error("late failure"));
  calls[0].source.emit("aborted");
  const next = send();
  while (calls.length < 5)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await send()).status, 503);
  calls[4].source.end("docs");
  assert.equal((await next).status, 200);
  const afterSuccess = send();
  while (calls.length < 6)
    await new Promise((resolve) => setImmediate(resolve));
  calls[5].upstream.emit("error", new Error("failure"));
  assert.equal((await afterSuccess).status, 502);
  const afterFailure = send();
  while (calls.length < 7)
    await new Promise((resolve) => setImmediate(resolve));
  calls[6].source.end("docs");
  assert.equal((await afterFailure).status, 200);
});
