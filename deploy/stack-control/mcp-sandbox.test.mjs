import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createMcpSandbox } from "./mcp-sandbox.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-mcp-test-"),
  );
  roots.push(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, "project"));
  const relayRoot = path.join(workspaceRoot, "relay");
  fs.mkdirSync(path.join(relayRoot, "context7"), { recursive: true });
  const calls = [];
  const nova = {
    Image: `sha256:${"a".repeat(64)}`,
    Mounts: [{ Type: "bind", Source: "/host/data", Destination: "/data" }],
  };
  const broker = {
    Mounts: [
      {
        Type: "bind",
        Source: "/host/data/workspace",
        Destination: "/workspace-host",
      },
      {
        Type: "bind",
        Source: "/host/data/mcp-relay",
        Destination: "/relay-host",
      },
    ],
  };
  let nextId = 0;
  const state = {
    nova,
    broker,
    rows: [
      { Id: "nova-id", Names: ["/nova"] },
      { Id: "broker-id", Names: ["/nova-stack-control"] },
    ],
    deleteError: null,
    createError: null,
  };
  const docker = async (url, method = "GET", body, options) => {
    calls.push({ url, method, body, ...(options ? { options } : {}) });
    if (url.startsWith("/containers/json?")) return state.rows;
    if (url === "/containers/nova-id/json") return nova;
    if (url === "/containers/broker-id/json") return broker;
    if (url.startsWith("/containers/create?")) {
      if (state.createError) throw state.createError;
      return { Id: `mcp-${++nextId}` };
    }
    if (method === "DELETE") {
      if (state.deleteFailures?.length) throw state.deleteFailures.shift();
      if (state.deleteError) throw state.deleteError;
      return null;
    }
    assert.fail(`unexpected Docker request: ${url}`);
  };
  return {
    workspaceRoot,
    relayRoot,
    calls,
    state,
    docker,
    sandbox: createMcpSandbox({
      docker,
      workspaceRoot,
      relayRoot,
      wait: async () => {},
    }),
  };
}

test("fixed offline containers have exact restricted configuration and are never started", async () => {
  const f = fixture();
  for (const server of ["sequential-thinking", "filesystem", "workspace-git"]) {
    const result = await f.sandbox.prepare({
      server,
      ...(server === "workspace-git" ? { projectId: "project" } : {}),
    });
    assert.match(result.containerId, /^mcp-\d+$/);
    const create = f.calls.at(-1);
    assert.equal(create.method, "POST");
    assert.deepEqual(create.options, { timeoutMs: 60_000 });
    assert.match(
      create.url,
      /^\/containers\/create\?name=nova-mcp-[a-f0-9-]+$/,
    );
    assert.deepEqual(create.body, {
      Image: `sha256:${"a".repeat(64)}`,
      User: "1000:1000",
      Healthcheck: { Test: ["NONE"] },
      Entrypoint: [],
      WorkingDir: "/tmp",
      Cmd:
        server === "workspace-git"
          ? [
              "/opt/git-mcp/bin/python",
              "-m",
              "mcp_server_git",
              "--repository",
              "/data/workspace/project",
            ]
          : server === "filesystem"
            ? ["mcp-server-filesystem", "/data/workspace"]
            : ["mcp-server-sequential-thinking"],
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME=/tmp",
        "PYTHONNOUSERSITE=1",
        "PYTHONDONTWRITEBYTECODE=1",
        "DISABLE_THOUGHT_LOGGING=true",
      ],
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 256 * 1024 * 1024,
        NanoCpus: 500_000_000,
        PidsLimit: 64,
        ShmSize: 16 * 1024 * 1024,
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,nodev,size=64m",
          "/data": "ro,noexec,nosuid,nodev,size=1m",
        },
        Mounts:
          server === "sequential-thinking"
            ? []
            : [
                {
                  Type: "bind",
                  Source:
                    server === "workspace-git"
                      ? "/host/data/workspace/project"
                      : "/host/data/workspace",
                  Target:
                    server === "workspace-git"
                      ? "/data/workspace/project"
                      : "/data/workspace",
                  ReadOnly: server === "workspace-git",
                },
              ],
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "32k", "max-file": "1" },
        },
      },
    });
  }
  assert.ok(f.calls.every(({ url }) => !url.endsWith("/start")));
});

test("Context7 sees only its verified readonly relay socket and cannot configure a destination", async () => {
  const f = fixture();
  const { containerId } = await f.sandbox.prepare({ server: "context7" });
  const body = f.calls.find((call) =>
    call.url.startsWith("/containers/create?"),
  ).body;
  assert.deepEqual(body.Cmd, [
    "node",
    "/app/stack-control/mcp-proxy-stdio.mjs",
    "context7",
  ]);
  assert.equal(body.HostConfig.NetworkMode, "none");
  assert.deepEqual(body.HostConfig.Mounts, [
    {
      Type: "bind",
      Source: "/host/data/mcp-relay/context7",
      Target: "/run/nova-mcp-relay",
      ReadOnly: true,
    },
  ]);
  await f.sandbox.close(containerId);
  await assert.rejects(
    f.sandbox.prepare({
      server: "context7",
      destination: "https://api.openai.com",
    }),
  );
  f.state.broker.Mounts.find(
    (mount) => mount.Destination === "/relay-host",
  ).Source = "/another/relay";
  await assert.rejects(f.sandbox.prepare({ server: "context7" }));
});

test("rejects unknown servers, extra fields and invalid project IDs before Docker access", async () => {
  const f = fixture();
  for (const input of [
    null,
    [],
    {},
    { server: "shell" },
    { server: "filesystem", projectId: undefined },
    { server: "workspace-git" },
    ...["../project", "/project", "Project", "a".repeat(49)].map(
      (projectId) => ({ server: "workspace-git", projectId }),
    ),
    ...["command", "env", "image", "network", "mounts"].map((field) => ({
      server: "filesystem",
      [field]: "override",
    })),
  ]) {
    await assert.rejects(f.sandbox.prepare(input), {
      message: "invalid MCP sandbox request",
    });
  }
  assert.equal(f.calls.length, 0);
});

test("requires exact named containers, bind mounts and pinned runtime image", async () => {
  const changes = [
    (f) => {
      f.state.rows = [];
    },
    (f) => {
      f.state.rows[0].Names = ["/nova-other"];
    },
    (f) => {
      f.state.nova.Image = "nova:latest";
    },
    (f) => {
      f.state.nova.Image = `sha256:${"z".repeat(64)}`;
    },
    (f) => {
      f.state.nova.Mounts[0].Type = "volume";
    },
    (f) => {
      f.state.nova.Mounts[0].Source = "relative";
    },
    (f) => {
      f.state.nova.Mounts[0].Source = "/host/alias/../data";
    },
    (f) => {
      f.state.broker.Mounts[0].Type = "volume";
    },
    (f) => {
      f.state.broker.Mounts[0].Source = "/host/other-workspace";
    },
    (f) => {
      f.state.broker.Mounts.push({ ...f.state.broker.Mounts[0] });
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
      message: "MCP sandbox unavailable",
    });
    assert.ok(f.calls.every(({ method }) => method !== "POST"));
  }
});

test("rejects workspace and project symlinks, ancestor aliases, files and missing directories", async () => {
  const f = fixture();
  fs.symlinkSync(
    path.join(f.workspaceRoot, "project"),
    path.join(f.workspaceRoot, "linked"),
  );
  fs.writeFileSync(path.join(f.workspaceRoot, "file"), "data");
  for (const projectId of ["linked", "file", "missing"]) {
    await assert.rejects(
      f.sandbox.prepare({ server: "workspace-git", projectId }),
      { message: "workspace unavailable" },
    );
  }
  const alias = path.join(f.workspaceRoot, "alias");
  fs.symlinkSync(f.workspaceRoot, alias);
  for (const workspaceRoot of [
    alias,
    path.join(alias, "project"),
    path.join(f.workspaceRoot, "file"),
    `${f.workspaceRoot}/project/..`,
    path.join(f.workspaceRoot, "missing"),
  ]) {
    const sandbox = createMcpSandbox({ docker: f.docker, workspaceRoot });
    await assert.rejects(sandbox.prepare({ server: "filesystem" }), {
      message: "workspace unavailable",
    });
  }
  assert.equal(f.calls.length, 0);
});

test("cleanup only removes owned containers, deduplicates closes and tolerates removed containers", async () => {
  const f = fixture();
  const { containerId } = await f.sandbox.prepare({ server: "filesystem" });
  await f.sandbox.close("nova-id");
  assert.equal(f.calls.filter(({ method }) => method === "DELETE").length, 0);
  f.state.deleteError = new Error("Docker API status 404");
  await Promise.all([
    f.sandbox.close(containerId),
    f.sandbox.close(containerId),
  ]);
  await f.sandbox.close(containerId);
  assert.deepEqual(
    f.calls.filter(({ method }) => method === "DELETE"),
    [
      {
        url: `/containers/${containerId}?force=1&v=1`,
        method: "DELETE",
        body: undefined,
        options: { timeoutMs: 60_000 },
      },
    ],
  );
});

test("eight concurrent preparations reserve slots, and failed cleanup retains capacity until retry", async () => {
  const f = fixture();
  const pending = Array.from({ length: 8 }, () =>
    f.sandbox.prepare({ server: "sequential-thinking" }),
  );
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox capacity reached",
  });
  const prepared = await Promise.all(pending);
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox capacity reached",
  });
  f.state.deleteError = new Error("private Docker daemon path");
  await assert.rejects(f.sandbox.close(prepared[0].containerId), {
    message: "MCP sandbox cleanup failed",
  });
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox capacity reached",
  });
  f.state.deleteError = null;
  await f.sandbox.close(prepared[0].containerId);
  await f.sandbox.prepare({ server: "filesystem" });
});

test("auto-removed workers release each confirmed reservation exactly once on Docker 404", async () => {
  const f = fixture();
  const workers = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.sandbox.prepare({ server: "sequential-thinking" }),
    ),
  );
  for (const call of f.calls.filter(({ method }) => method === "POST"))
    assert.equal(call.body.HostConfig.AutoRemove, true);
  f.state.deleteError = new Error("Docker API status 404");
  await Promise.all(
    workers.flatMap(({ containerId }) => [
      f.sandbox.close(containerId),
      f.sandbox.close(containerId),
    ]),
  );
  assert.equal(f.calls.filter(({ method }) => method === "DELETE").length, 8);
  f.state.deleteError = null;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      f.sandbox.prepare({ server: "sequential-thinking" }),
    ),
  );
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox capacity reached",
  });
});

test("failed preparation releases capacity and hides Docker errors", async () => {
  const f = fixture();
  f.state.createError = new Error("credential and private host path");
  for (let i = 0; i < 10; i += 1)
    await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
      message: "MCP sandbox unavailable",
    });
  f.state.createError = null;
  await f.sandbox.prepare({ server: "filesystem" });
});

test("timed-out creation retries exact reserved name after early 404 and releases only on removal", async () => {
  const f = fixture();
  f.state.createError = new Error("Docker timeout");
  f.state.deleteFailures = [
    new Error("Docker API status 404"),
    new Error("Docker API status 404"),
  ];
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox unavailable",
  });
  await new Promise(setImmediate);
  const creation = f.calls.find(({ method }) => method === "POST");
  const name = new URL(creation.url, "http://docker").searchParams.get("name");
  const deletes = f.calls.filter(({ method }) => method === "DELETE");
  assert.equal(deletes.length, 3);
  assert.ok(
    deletes.every(({ url }) => url === `/containers/${name}?force=1&v=1`),
  );
  f.state.createError = null;
  for (let i = 0; i < 8; i += 1)
    await f.sandbox.prepare({ server: "filesystem" });
});

test("missing late creations exhaust bounded polling and retain all eight reservations", async () => {
  const f = fixture();
  f.state.createError = new Error("Docker timeout");
  f.state.deleteError = new Error("Docker API status 404");
  for (let i = 0; i < 8; i += 1)
    await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
      message: "MCP sandbox unavailable",
    });
  await new Promise(setImmediate);
  const names = f.calls
    .filter(({ method }) => method === "POST")
    .map(({ url }) => new URL(url, "http://docker").searchParams.get("name"));
  for (const name of names)
    assert.equal(
      f.calls.filter(
        ({ method, url }) =>
          method === "DELETE" && url === `/containers/${name}?force=1&v=1`,
      ).length,
      12,
    );
  f.state.createError = null;
  await assert.rejects(f.sandbox.prepare({ server: "filesystem" }), {
    message: "MCP sandbox capacity reached",
  });
  // Explicit later cleanup can release a retained slot only after verified removal.
  f.state.deleteError = null;
  await f.sandbox.close(names[0]);
  await f.sandbox.prepare({ server: "filesystem" });
});

test("mail and calendar workers receive scoped credentials and no host data mounts", async () => {
  const f = fixture();
  const inputs = [
    {
      server: "imap",
      credentials: {
        IMAP_HOST: "mail.fixture.invalid",
        IMAP_USER: "fixture-user",
        IMAP_PASSWORD: "fixture-secret",
      },
    },
    {
      server: "caldav",
      credentials: {
        CALDAV_URL: "https://calendar.fixture.invalid/",
        CALDAV_USERNAME: "fixture-user",
        CALDAV_PASSWORD: "fixture-secret",
      },
    },
  ];
  for (const input of inputs) {
    await f.sandbox.prepare(input);
    const config = f.calls.at(-1).body;
    assert.deepEqual(config.Cmd, [
      `/opt/${input.server}-mcp/node_modules/.bin/${input.server}-mcp`,
    ]);
    assert.equal(config.HostConfig.NetworkMode, "bridge");
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(config.HostConfig.Mounts, []);
    assert.deepEqual(config.HostConfig.CapDrop, ["ALL"]);
    assert.equal(config.User, "1000:1000");
    assert.ok(
      config.Env.includes(
        `${input.server === "imap" ? "IMAP_PASSWORD" : "CALDAV_PASSWORD"}=fixture-secret`,
      ),
    );
    assert.ok(
      !config.Env.some((value) =>
        /NOVA_|STACK_CONTROL|GITHUB|OPENAI/.test(value),
      ),
    );
    assert.ok(
      config.Env.includes(
        input.server === "imap"
          ? "IMAP_READ_ONLY=true"
          : "CALDAV_READ_ONLY=true",
      ),
    );
  }
  for (const input of [
    { server: "filesystem", credentials: { IMAP_PASSWORD: "secret" } },
    {
      server: "imap",
      credentials: {
        IMAP_HOST: "mail.fixture.invalid",
        IMAP_USER: "user",
        IMAP_PASSWORD: "secret",
        NOVA_APP_TOKEN: "private",
      },
    },
    {
      server: "caldav",
      credentials: {
        CALDAV_URL: "http://calendar.fixture.invalid",
        CALDAV_USERNAME: "user",
        CALDAV_PASSWORD: "secret",
      },
    },
    { server: "imap" },
  ])
    await assert.rejects(() => f.sandbox.prepare(input));
});
