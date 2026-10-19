import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { createMcpUpgradeHandler, dockerAttach } from "./mcp-stream.mjs";

class DockerStream extends Duplex {
  input = [];
  _read() {}
  _write(chunk, encoding, callback) {
    this.input.push(Buffer.from(chunk));
    callback();
  }
}

function frame(text, stream = 1, length) {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(length ?? bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

async function fixture(t, overrides = {}) {
  const calls = [];
  const stream = new DockerStream();
  const handler = createMcpUpgradeHandler({
    sandbox: {
      async prepare(input) {
        calls.push(["prepare", input]);
        return { containerId: "mcp-id" };
      },
      async close(id) {
        calls.push(["close", id]);
      },
      ...overrides.sandbox,
    },
    async docker(path, method) {
      calls.push(["start", path, method]);
    },
    async attach(id) {
      calls.push(["attach", id]);
      return stream;
    },
    authorized: (request) => request.headers.authorization === "Bearer secret",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "sandbox"),
    ),
  });
  const sockets = new Set();
  const server = http.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    stream.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  function connect(
    path = "/mcp/offline?server=sequential-thinking",
    options = {},
  ) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "nova-mcp",
          Authorization: "Bearer secret",
          ...options.headers,
        },
      });
      request.on("error", reject);
      request.on("response", (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      });
      request.on("upgrade", (response, socket, head) => {
        const output = [head];
        socket.on("data", (chunk) => output.push(chunk));
        socket.on("error", () => {});
        t.after(() => socket.destroy());
        resolve({
          status: response.statusCode,
          socket,
          output: () => Buffer.concat(output).toString(),
        });
      });
      request.end();
    });
  }
  return { calls, stream, connect, port, handler };
}

test("authentication rejects before any sandbox or Docker operation", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.connect(undefined, { headers: { Authorization: "Bearer wrong" } }))
      .status,
    401,
  );
  assert.deepEqual(f.calls, []);
});

test("only fixed server and project parameters and the fixed upgrade are accepted", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/mcp/offline?server=unknown",
    "/mcp/offline?server=filesystem&server=filesystem",
    "/mcp/offline?server=filesystem&command=whoami",
    "/mcp/offline?server=filesystem&env=secret",
    "/mcp/offline?server=filesystem&network=host",
    "/mcp/offline?server=filesystem&projectId=project",
    "/mcp/offline?server=workspace-git",
    "/mcp/offline?server=workspace-git&projectId=../outside",
    "/mcp/offline?server=workspace-git&projectId=a&projectId=b",
    "/other?server=filesystem",
  ])
    assert.equal((await f.connect(path)).status, 400, path);
  assert.equal((await f.connect(undefined, { method: "POST" })).status, 400);
  assert.equal(
    (await f.connect(undefined, { headers: { Upgrade: "websocket" } })).status,
    400,
  );
  assert.deepEqual(f.calls, []);
});

test("nonempty upgrade head is rejected without sandbox preparation", async (t) => {
  const f = await fixture(t);
  const socket = net.connect(f.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  let output = "";
  socket.on("data", (chunk) => {
    output += chunk;
  });
  socket.write(
    "GET /mcp/offline?server=filesystem HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\nAuthorization: Bearer secret\r\n\r\nextra",
  );
  await once(socket, "close");
  assert.match(output, /^HTTP\/1.1 400 /);
  assert.deepEqual(f.calls, []);
});

test("attach precedes start and raw newline MCP flows both ways, excluding stderr", async (t) => {
  const f = await fixture(t);
  const client = await f.connect(
    "/mcp/offline?server=workspace-git&projectId=my-project",
  );
  assert.equal(client.status, 101);
  assert.deepEqual(f.calls, [
    ["prepare", { server: "workspace-git", projectId: "my-project" }],
    ["attach", "mcp-id"],
    ["start", "/containers/mcp-id/start", "POST"],
  ]);
  const input = '{"jsonrpc":"2.0","method":"initialize","id":1}\n';
  client.socket.write(input);
  await until(() => f.stream.input.length > 0);
  assert.equal(Buffer.concat(f.stream.input).toString(), input);
  f.stream.push(
    Buffer.concat([
      frame("secret diagnostic\n", 2),
      frame('{"id":1,"result":{}}\n'),
    ]),
  );
  await until(() => client.output().includes("result"));
  assert.equal(client.output(), '{"id":1,"result":{}}\n');
  client.socket.destroy();
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.equal(f.stream.destroyed, true);
  assert.equal(f.calls.filter(([call]) => call === "close").length, 1);
});

test("split Docker headers and payloads preserve stdout across frame boundaries", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const bytes = Buffer.concat([
    frame("sec", 2),
    frame('{"id":'),
    frame("1}\n"),
  ]);
  for (let offset = 0; offset < bytes.length; offset++)
    f.stream.push(bytes.subarray(offset, offset + 1));
  await until(() => client.output().endsWith("\n"));
  assert.equal(client.output(), '{"id":1}\n');
});

test("invalid and oversized Docker frames close and clean the session", async (t) => {
  for (const bytes of [
    frame("", 1, 1024 * 1024 + 1),
    frame("secret", 3),
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
  ]) {
    const f = await fixture(t);
    const client = await f.connect();
    const closed = once(client.socket, "close");
    f.stream.push(bytes);
    await closed;
    await until(() => f.calls.some(([call]) => call === "close"));
    assert.equal(client.output(), "");
    assert.equal(f.stream.destroyed, true);
  }
});

test("message byte limits span chunks and Docker frames", async (t) => {
  for (const direction of ["input", "output"]) {
    const f = await fixture(t);
    const client = await f.connect();
    const closed = once(client.socket, "close");
    if (direction === "input") {
      client.socket.write(Buffer.alloc(1024 * 1024, 97));
      client.socket.write(Buffer.from("b"));
    } else {
      f.stream.push(frame("a".repeat(1024 * 1024)));
      f.stream.push(frame("b"));
    }
    await closed;
    await until(() => f.calls.some(([call]) => call === "close"));
    assert.equal(f.stream.destroyed, true);
  }
});

test("disconnect during pending prepare cleans the eventual container without attaching", async (t) => {
  let finishPrepare;
  let preparing = false;
  const f = await fixture(t, {
    sandbox: {
      prepare() {
        preparing = true;
        return new Promise((resolve) => {
          finishPrepare = resolve;
        });
      },
    },
  });
  const client = net.connect(f.port, "127.0.0.1");
  client.on("error", () => {});
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /mcp/offline?server=filesystem HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\nAuthorization: Bearer secret\r\n\r\n",
  );
  await until(() => preparing);
  client.end();
  await once(client, "close");
  finishPrepare({ containerId: "late-id" });
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.deepEqual(f.calls, [["close", "late-id"]]);
});

test("disconnect while attaching destroys a late attachment and never starts", async (t) => {
  let finishAttach;
  const f = await fixture(t, {
    attach() {
      return new Promise((resolve) => {
        finishAttach = resolve;
      });
    },
  });
  const client = net.connect(f.port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /mcp/offline?server=filesystem HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\nAuthorization: Bearer secret\r\n\r\n",
  );
  await until(() => finishAttach);
  client.end();
  await once(client, "close");
  finishAttach(f.stream);
  await until(() => f.stream.destroyed);
  assert.deepEqual(
    f.calls.map(([call]) => call),
    ["prepare", "close"],
  );
});

test("internal failures expose no raw error and clean a prepared container", async (t) => {
  const f = await fixture(t, {
    attach() {
      throw new Error("private Docker secret");
    },
  });
  assert.equal((await f.connect()).status, 503);
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.deepEqual(
    f.calls.map(([call]) => call),
    ["prepare", "close"],
  );
});

test("Docker disconnect closes the client and removes its container", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const closed = once(client.socket, "close");
  f.stream.push(null);
  await closed;
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.equal(f.stream.destroyed, true);
});

test("75-second preparation timeout closes the request and cleans a late container", async (t) => {
  let finishPrepare;
  let ready;
  const preparing = new Promise((resolve) => {
    ready = resolve;
  });
  const f = await fixture(t, {
    sandbox: {
      prepare() {
        ready();
        return new Promise((resolve) => {
          finishPrepare = resolve;
        });
      },
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connection = f.connect();
  await preparing;
  t.mock.timers.tick(75_000);
  assert.equal((await connection).status, 503);
  t.mock.timers.reset();
  finishPrepare({ containerId: "timeout-id" });
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.deepEqual(f.calls, [["close", "timeout-id"]]);
});

test("30-minute lifetime closes active streams and cleans the sandbox", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = await f.connect();
  const closed = once(client.socket, "close");
  t.mock.timers.tick(30 * 60_000);
  await closed;
  t.mock.timers.reset();
  await until(() => f.calls.some(([call]) => call === "close"));
  assert.equal(f.stream.destroyed, true);
});

test("Docker attach uses the Unix socket and preserves upgrade head bytes", async (t) => {
  const stream = new DockerStream();
  const head = frame('{"id":1}\n');
  const request = new EventEmitter();
  request.end = () =>
    queueMicrotask(() =>
      request.emit(
        "upgrade",
        { statusCode: 101, headers: { upgrade: "tcp" } },
        stream,
        head,
      ),
    );
  request.destroy = () => {};
  let options;
  t.mock.method(http, "request", (input) => {
    options = input;
    return request;
  });
  const attached = await dockerAttach("fixed/id");
  assert.equal(attached, stream);
  assert.equal(attached.isPaused(), true);
  assert.deepEqual(attached.read(), head);
  assert.deepEqual(options, {
    socketPath: "/var/run/docker.sock",
    path: "/containers/fixed%2Fid/attach?stream=1&stdin=1&stdout=1&stderr=1",
    method: "POST",
    headers: { Connection: "Upgrade", Upgrade: "tcp" },
  });
  stream.destroy();
});

test("Docker attach has a bounded timeout with sanitized errors", async (t) => {
  const request = new EventEmitter();
  let destroyed = false;
  request.end = () => {};
  request.destroy = () => {
    destroyed = true;
  };
  t.mock.method(http, "request", () => request);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attachment = dockerAttach("fixed");
  t.mock.timers.tick(75_000);
  await assert.rejects(attachment, /^Error: MCP attachment unavailable$/);
  assert.equal(destroyed, true);
});

test("shutdown awaits cleanup and retries a failed removal after one second", async (t) => {
  let attempts = 0;
  let removed = false;
  const f = await fixture(t, {
    sandbox: {
      async close(id) {
        assert.equal(id, "mcp-id");
        attempts++;
        if (attempts === 1) throw new Error("private removal diagnostic");
        removed = true;
      },
    },
  });
  const client = await f.connect();
  const closed = once(client.socket, "close");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shutdown = f.handler.shutdown();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(removed, false);
  assert.equal(f.stream.destroyed, true);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await shutdown;
  assert.equal(attempts, 2);
  assert.equal(removed, true);
  await closed;
  t.mock.timers.reset();
  assert.equal((await f.connect()).status, 503);
  await f.handler.closeAll();
  assert.equal(attempts, 2);
});

test("cleanup stops after three attempts and shutdown reports only its fixed failure", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    sandbox: {
      async close() {
        attempts++;
        throw new Error("private Docker diagnostic");
      },
    },
  });
  await f.connect();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = assert.rejects(
    f.handler.closeAll(),
    /^Error: MCP sandbox cleanup failed$/,
  );
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await failure;
  assert.equal(attempts, 3);
  await assert.rejects(
    f.handler.shutdown(),
    /^Error: MCP sandbox cleanup failed$/,
  );
  assert.equal(attempts, 3);
});

test("shutdown closes every active stream and awaits cleanup of every owned ID", async (t) => {
  let nextId = 0;
  const streams = [];
  const removedIds = [];
  const f = await fixture(t, {
    sandbox: {
      async prepare() {
        return { containerId: `owned-${++nextId}` };
      },
      async close(id) {
        removedIds.push(id);
      },
    },
    async attach() {
      const stream = new DockerStream();
      streams.push(stream);
      return stream;
    },
  });
  const clients = await Promise.all([f.connect(), f.connect()]);
  const closed = clients.map(({ socket }) => once(socket, "close"));
  await f.handler.shutdown();
  await Promise.all(closed);
  assert.deepEqual(removedIds.sort(), ["owned-1", "owned-2"]);
  assert.equal(streams.length, 2);
  assert.ok(streams.every((stream) => stream.destroyed));
});

test("shutdown waits for pending preparation and cleans the eventual owned container", async (t) => {
  let finishPrepare;
  let ready;
  const preparing = new Promise((resolve) => {
    ready = resolve;
  });
  const f = await fixture(t, {
    sandbox: {
      prepare() {
        ready();
        return new Promise((resolve) => {
          finishPrepare = resolve;
        });
      },
    },
  });
  const connection = f.connect().catch(() => null);
  await preparing;
  let finished = false;
  const shutdown = f.handler.shutdown().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  finishPrepare({ containerId: "shutdown-late-id" });
  await shutdown;
  await connection;
  assert.deepEqual(f.calls, [["close", "shutdown-late-id"]]);
});

test("authenticated network provider credentials travel outside the request URL", async (t) => {
  const f = await fixture(t);
  const credentials = {
    IMAP_HOST: "mail.fixture.invalid",
    IMAP_USER: "fixture-user",
    IMAP_PASSWORD: "fixture-secret",
  };
  const encoded = Buffer.from(JSON.stringify(credentials)).toString(
    "base64url",
  );
  const response = await f.connect("/mcp/offline?server=imap", {
    headers: { "x-nova-mcp-credentials": encoded },
  });
  assert.equal(response.status, 101);
  assert.deepEqual(
    f.calls.find((call) => call[0] === "prepare"),
    ["prepare", { server: "imap", credentials }],
  );
  assert.equal((await f.connect("/mcp/offline?server=imap")).status, 400);
  assert.equal(
    (
      await f.connect("/mcp/offline?server=filesystem", {
        headers: { "x-nova-mcp-credentials": encoded },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.connect("/mcp/offline?server=imap", {
        headers: {
          Authorization: "Bearer wrong",
          "x-nova-mcp-credentials": encoded,
        },
      })
    ).status,
    401,
  );
});
