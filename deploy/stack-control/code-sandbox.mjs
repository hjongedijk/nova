import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MAX_ARGS = 32;
const MAX_ARGUMENT_CHARS = 1024;
const MAX_OUTPUT = 32 * 1024;
const MAX_RUNTIME_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

function mountAt(detail, destination) {
  const mounts = Array.isArray(detail?.Mounts) ? detail.Mounts : [];
  return mounts.find((mount) => mount?.Destination === destination);
}

function projectPath(root, id) {
  if (typeof id !== "string" || !PROJECT_ID.test(id)) fail("invalid project");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail("workspace unavailable");
  const expected = path.join(root, id);
  const stat = fs.lstatSync(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("project unavailable");
  const resolved = fs.realpathSync(expected);
  if (resolved !== path.resolve(expected)) fail("project path rejected");
  return resolved;
}

function parseDockerLogs(buffer) {
  const output = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail("invalid sandbox output");
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (![1, 2].includes(stream) || offset + size > buffer.length)
      fail("invalid sandbox output");
    output.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat(output).toString("utf8");
}

/** A one-shot container runner. Docker configuration is constructed here, never caller supplied. */
export function createCodeSandbox({
  docker,
  workspaceRoot = "/workspace-host",
}) {
  if (typeof docker !== "function")
    throw new TypeError("docker adapter required");

  return {
    async run(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Object.keys(input).some(
          (key) => !["projectId", "command"].includes(key),
        ) ||
        !Array.isArray(input.command) ||
        input.command.length < 1 ||
        input.command.length > MAX_ARGS ||
        input.command.some(
          (arg) =>
            typeof arg !== "string" ||
            arg.length < 1 ||
            arg.length > MAX_ARGUMENT_CHARS ||
            arg.includes("\0"),
        )
      )
        fail("invalid sandbox request");

      const id = input.projectId;
      projectPath(workspaceRoot, id);
      const filters = encodeURIComponent(
        JSON.stringify({ name: ["nova", "nova-stack-control"] }),
      );
      const containers = await docker(
        `/containers/json?all=1&filters=${filters}`,
      );
      const find = (name) =>
        Array.isArray(containers)
          ? containers.find((row) => row?.Names?.includes(`/${name}`))
          : undefined;
      const nova = find("nova");
      const broker = find("nova-stack-control");
      if (!nova?.Id || !broker?.Id) fail("sandbox unavailable");
      const [novaInfo, brokerInfo] = await Promise.all([
        docker(`/containers/${encodeURIComponent(nova.Id)}/json`),
        docker(`/containers/${encodeURIComponent(broker.Id)}/json`),
      ]);
      const dataMount = mountAt(novaInfo, "/data");
      const workspaceMount = mountAt(brokerInfo, "/workspace-host");
      if (
        dataMount?.Type !== "bind" ||
        typeof dataMount.Source !== "string" ||
        !path.isAbsolute(dataMount.Source) ||
        workspaceMount?.Type !== "bind" ||
        workspaceMount.Source !== path.join(dataMount.Source, "workspace") ||
        typeof novaInfo.Image !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(novaInfo.Image)
      )
        fail("workspace mount or runtime image could not be verified");
      const hostProjectPath = path.join(workspaceMount.Source, id);

      const containerName = `nova-code-${crypto.randomUUID()}`;
      const deadline = Date.now() + MAX_RUNTIME_MS;
      let containerId;
      let timedOut = false;
      try {
        const created = await docker(
          `/containers/create?name=${encodeURIComponent(containerName)}`,
          "POST",
          {
            Image: novaInfo.Image,
            User: "1000:1000",
            WorkingDir: "/workspace",
            Cmd: input.command,
            Env: [
              "HOME=/tmp",
              "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              "NODE_ENV=development",
            ],
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
              Mounts: [
                {
                  Type: "bind",
                  Source: hostProjectPath,
                  Target: "/workspace",
                  ReadOnly: false,
                },
              ],
              LogConfig: {
                Type: "json-file",
                Config: { "max-size": "32k", "max-file": "1" },
              },
            },
          },
        );
        if (typeof created?.Id !== "string") fail("sandbox create failed");
        containerId = created.Id;
        await docker(
          `/containers/${encodeURIComponent(containerId)}/start`,
          "POST",
        );
        let result;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Docker timeout");
          result = await docker(
            `/containers/${encodeURIComponent(containerId)}/wait?condition=not-running`,
            "POST",
            undefined,
            { timeoutMs: remaining },
          );
        } catch (error) {
          if (
            !String(error?.message ?? error)
              .toLowerCase()
              .includes("timeout")
          )
            throw error;
          timedOut = true;
          result = null;
        }
        const bytes = await docker(
          `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=0`,
          "GET",
          undefined,
          { raw: true, maxBytes: MAX_OUTPUT + 8 * MAX_ARGS, timeoutMs: 5000 },
        );
        const output = parseDockerLogs(bytes);
        const statusCode =
          Number.isInteger(result?.StatusCode) && result.StatusCode >= 0
            ? result.StatusCode
            : null;
        return {
          ok: statusCode === 0 && !timedOut,
          statusCode,
          timedOut,
          output: output.slice(0, MAX_OUTPUT),
          truncated: Buffer.byteLength(output, "utf8") > MAX_OUTPUT,
        };
      } finally {
        if (containerId) {
          if (timedOut) {
            try {
              await docker(
                `/containers/${encodeURIComponent(containerId)}/kill`,
                "POST",
              );
            } catch {
              // Continue to forced removal.
            }
          }
          try {
            await docker(
              `/containers/${encodeURIComponent(containerId)}?force=1&v=1`,
              "DELETE",
            );
          } catch {
            // Runtime response remains useful; the daemon can reap the stopped container later.
          }
        }
      }
    },
  };
}
