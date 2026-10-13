import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SERVERS = new Set([
  "sequential-thinking",
  "filesystem",
  "workspace-git",
  "context7",
]);
const MAX_CONTAINERS = 8;
const CREATE_TIMEOUT_MS = 60_000;
const CLEANUP_ATTEMPTS = 12;
const waitForCleanup = () =>
  new Promise((resolve) => setTimeout(resolve, 5000));

function fail(message) {
  throw new Error(message);
}

function realDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    )
      fail("workspace unavailable");
  } catch {
    fail("workspace unavailable");
  }
}

function mountAt(detail, destination) {
  const mounts = Array.isArray(detail?.Mounts)
    ? detail.Mounts.filter((mount) => mount?.Destination === destination)
    : [];
  return mounts.length === 1 ? mounts[0] : undefined;
}

/** Creates fixed offline MCP containers; the transport must attach before starting. */
export function createMcpSandbox({
  docker,
  workspaceRoot = "/workspace-host",
  relayRoot = "/relay-host",
  wait = waitForCleanup,
}) {
  if (typeof docker !== "function")
    throw new TypeError("docker adapter required");
  const createdIds = new Set();
  const pendingNames = new Set();
  const closing = new Map();
  let slots = 0;

  async function closeOwned(containerId) {
    if (!createdIds.has(containerId)) return;
    if (closing.has(containerId)) return closing.get(containerId);
    const cleanup = (async () => {
      try {
        await docker(
          `/containers/${encodeURIComponent(containerId)}?force=1&v=1`,
          "DELETE",
          undefined,
          { timeoutMs: CREATE_TIMEOUT_MS },
        );
      } catch (error) {
        const missing =
          error?.statusCode === 404 ||
          error?.message === "Docker API status 404";
        // A timed-out create may still finish after an early 404. Only a
        // successful DELETE verifies cleanup of an unconfirmed worker name.
        if (!missing || pendingNames.has(containerId))
          fail("MCP sandbox cleanup failed");
      }
      createdIds.delete(containerId);
      pendingNames.delete(containerId);
      slots -= 1;
    })();
    closing.set(containerId, cleanup);
    try {
      await cleanup;
    } finally {
      closing.delete(containerId);
    }
  }

  async function recoverPending(name) {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await closeOwned(name);
        return;
      } catch {
        if (attempt + 1 < CLEANUP_ATTEMPTS) await wait();
      }
    }
    // Keep ownership and the slot if Docker never confirms removal. Unknown
    // outcomes must not permit unbounded replacement workers.
  }

  return {
    async prepare(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Reflect.ownKeys(input).some(
          (key) => !["server", "projectId"].includes(key),
        ) ||
        !SERVERS.has(input.server) ||
        (input.server === "workspace-git"
          ? typeof input.projectId !== "string" ||
            !PROJECT_ID.test(input.projectId)
          : Object.hasOwn(input, "projectId"))
      )
        fail("invalid MCP sandbox request");
      if (slots >= MAX_CONTAINERS) fail("MCP sandbox capacity reached");
      slots += 1;
      let workerName;
      try {
        realDirectory(workspaceRoot);
        if (input.server === "workspace-git")
          realDirectory(path.join(workspaceRoot, input.projectId));
        const filters = encodeURIComponent(
          JSON.stringify({ name: ["nova", "nova-stack-control"] }),
        );
        const rows = await docker(`/containers/json?all=1&filters=${filters}`);
        const find = (name) =>
          Array.isArray(rows)
            ? rows.find((row) => row?.Names?.includes(`/${name}`))
            : undefined;
        const nova = find("nova");
        const broker = find("nova-stack-control");
        if (!nova?.Id || !broker?.Id) fail("MCP sandbox unavailable");
        const [novaInfo, brokerInfo] = await Promise.all([
          docker(`/containers/${encodeURIComponent(nova.Id)}/json`),
          docker(`/containers/${encodeURIComponent(broker.Id)}/json`),
        ]);
        const data = mountAt(novaInfo, "/data");
        const workspace = mountAt(brokerInfo, "/workspace-host");
        if (
          data?.Type !== "bind" ||
          typeof data.Source !== "string" ||
          !path.isAbsolute(data.Source) ||
          path.resolve(data.Source) !== data.Source ||
          workspace?.Type !== "bind" ||
          workspace.Source !== path.join(data.Source, "workspace") ||
          typeof novaInfo.Image !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(novaInfo.Image)
        )
          fail("MCP sandbox unavailable");
        const git = input.server === "workspace-git";
        const context7 = input.server === "context7";
        const relay = context7 ? mountAt(brokerInfo, "/relay-host") : undefined;
        if (context7) {
          if (
            relay?.Type !== "bind" ||
            relay.Source !== path.join(data.Source, "mcp-relay")
          )
            fail("MCP sandbox unavailable");
          realDirectory(relayRoot);
          realDirectory(path.join(relayRoot, "context7"));
        }
        const cmd = git
          ? [
              "/opt/git-mcp/bin/python",
              "-m",
              "mcp_server_git",
              "--repository",
              `/data/workspace/${input.projectId}`,
            ]
          : input.server === "filesystem"
            ? ["mcp-server-filesystem", "/data/workspace"]
            : context7
              ? ["node", "/app/stack-control/mcp-proxy-stdio.mjs", "context7"]
              : ["mcp-server-sequential-thinking"];
        workerName = `nova-mcp-${crypto.randomUUID()}`;
        createdIds.add(workerName);
        pendingNames.add(workerName);
        const created = await docker(
          `/containers/create?name=${encodeURIComponent(workerName)}`,
          "POST",
          {
            Image: novaInfo.Image,
            User: "1000:1000",
            Entrypoint: [],
            WorkingDir: "/tmp",
            Cmd: cmd,
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
              Mounts: context7
                ? [
                    {
                      Type: "bind",
                      Source: path.join(relay.Source, "context7"),
                      Target: "/run/nova-mcp-relay",
                      ReadOnly: true,
                    },
                  ]
                : input.server === "sequential-thinking"
                  ? []
                  : [
                      {
                        Type: "bind",
                        Source: git
                          ? path.join(workspace.Source, input.projectId)
                          : workspace.Source,
                        Target: git
                          ? `/data/workspace/${input.projectId}`
                          : "/data/workspace",
                        ReadOnly: git,
                      },
                    ],
              LogConfig: {
                Type: "json-file",
                Config: { "max-size": "32k", "max-file": "1" },
              },
            },
          },
          { timeoutMs: CREATE_TIMEOUT_MS },
        );
        if (typeof created?.Id !== "string" || !created.Id)
          fail("MCP sandbox unavailable");
        createdIds.delete(workerName);
        pendingNames.delete(workerName);
        createdIds.add(created.Id);
        return { containerId: created.Id };
      } catch (error) {
        if (workerName) void recoverPending(workerName).catch(() => {});
        else slots -= 1;
        if (error?.message === "workspace unavailable") throw error;
        fail("MCP sandbox unavailable");
      }
    },

    close: closeOwned,
  };
}
