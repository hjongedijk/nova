import crypto from "node:crypto";

const MAX_SCAD_BYTES = 64 * 1024;
const MAX_RUNTIME_MS = 60_000;
const MAX_LOG_BYTES = 24 * 1024 * 1024;
const MAX_STL_BASE64 = 20 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function demux(buffer) {
  const out = [];
  const err = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail("invalid cad output");
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (![1, 2].includes(stream) || offset + size > buffer.length)
      fail("invalid cad output");
    (stream === 1 ? out : err).push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return {
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
}

/**
 * A one-shot OpenSCAD container: no network, read-only root, no capabilities, small tmpfs, hard time and
 * memory limits. The source goes in through an environment variable and the binary STL comes back as base64
 * on stdout. Docker configuration is built here, never taken from the caller.
 */
export function createCadSandbox({
  docker,
  image = process.env.NOVA_CAD_IMAGE || "nova-cad:openscad",
}) {
  if (typeof docker !== "function")
    throw new TypeError("docker adapter required");
  return {
    async render(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Object.keys(input).some((key) => key !== "scad") ||
        typeof input.scad !== "string" ||
        !input.scad.trim() ||
        input.scad.includes("\0") ||
        Buffer.byteLength(input.scad) > MAX_SCAD_BYTES
      )
        fail("invalid cad request");
      const containerName = `nova-cad-${crypto.randomUUID()}`;
      const deadline = Date.now() + MAX_RUNTIME_MS;
      let containerId;
      let timedOut = false;
      try {
        const created = await docker(
          `/containers/create?name=${encodeURIComponent(containerName)}`,
          "POST",
          {
            Image: image,
            User: "1000:1000",
            WorkingDir: "/tmp",
            Cmd: [
              "sh",
              "-c",
              'set -eu; printf %s "$SCAD_B64" | base64 -d > /tmp/in.scad; openscad -o /tmp/out.stl --export-format binstl /tmp/in.scad 1>&2; base64 -w0 /tmp/out.stl',
            ],
            Env: [
              "HOME=/tmp",
              `SCAD_B64=${Buffer.from(input.scad, "utf8").toString("base64")}`,
            ],
            HostConfig: {
              NetworkMode: "none",
              ReadonlyRootfs: true,
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges:true"],
              Memory: 768 * 1024 * 1024,
              NanoCpus: 1_000_000_000,
              PidsLimit: 64,
              Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=96m" },
              LogConfig: {
                Type: "json-file",
                Config: { "max-size": "24m", "max-file": "1" },
              },
            },
          },
        );
        if (typeof created?.Id !== "string") fail("cad create failed");
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
          { raw: true, maxBytes: MAX_LOG_BYTES, timeoutMs: 10_000 },
        );
        const { stdout, stderr } = demux(bytes);
        const statusCode =
          Number.isInteger(result?.StatusCode) && result.StatusCode >= 0
            ? result.StatusCode
            : null;
        const stl = stdout.trim();
        const valid =
          statusCode === 0 &&
          !timedOut &&
          stl.length > 0 &&
          stl.length <= MAX_STL_BASE64 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(stl);
        return {
          ok: valid,
          statusCode,
          timedOut,
          stl: valid ? stl : null,
          log: stderr.slice(-4000),
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
              // forced removal follows
            }
          }
          try {
            await docker(
              `/containers/${encodeURIComponent(containerId)}?force=1&v=1`,
              "DELETE",
            );
          } catch {
            // the daemon reaps a stopped container later
          }
        }
      }
    },
  };
}

export const cadSandboxLimits = Object.freeze({
  maxScadBytes: MAX_SCAD_BYTES,
  maxRuntimeMs: MAX_RUNTIME_MS,
});
