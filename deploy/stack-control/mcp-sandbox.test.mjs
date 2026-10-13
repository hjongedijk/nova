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
  const docker = async (url, method = "GET", body) => {
    calls.push({ url, method, body });
    if (url.startsWith("/containers/json?")) return state.rows;
    if (url === "/containers/nova-id/json") return nova;
    if (url === "/containers/broker-id/json") return broker;
    if (url.startsWith("/containers/create?")) {
      if (state.createError) throw state.createError;
      return { Id: `mcp-${++nextId}` };
    }
    if (method === "DELETE") {
      if (state.deleteError) throw state.deleteError;
      return null;
    }
    assert.fail(`unexpected Docker request: ${url}`);
  };
  return {
    workspaceRoot,
    calls,
    state,
    docker,
    sandbox: createMcpSandbox({ docker, workspaceRoot }),
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
    assert.match(
      create.url,
      /^\/containers\/create\?name=nova-mcp-[a-f0-9-]+$/,
    );
    assert.deepEqual(create.body, {
      Image: `sha256:${"a".repeat(64)}`,
      User: "1000:1000",
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
