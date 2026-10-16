import assert from "node:assert/strict";
import { test } from "node:test";
import { createCadSandbox } from "./cad-sandbox.mjs";

function frame(stream, text) {
  const body = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function fakeDocker({
  stdout = "QUJD",
  stderr = "ok",
  status = 0,
  hang = false,
} = {}) {
  const calls = [];
  const docker = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.startsWith("/containers/create")) return { Id: "cad1" };
    if (path.includes("/wait")) {
      if (hang) throw new Error("Docker timeout");
      return { StatusCode: status };
    }
    if (path.includes("/logs"))
      return Buffer.concat([frame(1, stdout), frame(2, stderr)]);
    return {};
  };
  return { docker, calls };
}

test("renders inside a locked-down container and removes it", async () => {
  const { docker, calls } = fakeDocker();
  const result = await createCadSandbox({ docker }).render({
    scad: "cube(1);",
  });
  assert.equal(result.ok, true);
  assert.equal(result.stl, "QUJD");
  const create = calls.find((c) =>
    c.path.startsWith("/containers/create"),
  ).body;
  assert.equal(create.HostConfig.NetworkMode, "none");
  assert.equal(create.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(create.HostConfig.CapDrop, ["ALL"]);
  assert.ok(create.HostConfig.Memory <= 1024 * 1024 * 1024);
  assert.ok(create.HostConfig.PidsLimit <= 128);
  assert.equal(create.User, "1000:1000");
  assert.equal(
    create.Env.find((e) => e.startsWith("SCAD_B64=")),
    `SCAD_B64=${Buffer.from("cube(1);").toString("base64")}`,
  );
  assert.ok(
    calls.some((c) => c.method === "DELETE" && c.path.includes("force=1")),
  );
});

test("rejects malformed or oversized requests before touching Docker", async () => {
  const { docker, calls } = fakeDocker();
  const sandbox = createCadSandbox({ docker });
  for (const bad of [
    null,
    {},
    { scad: "" },
    { scad: 5 },
    { scad: "a\0b" },
    { scad: "x".repeat(70_000) },
    { scad: "cube(1);", image: "evil" },
  ])
    await assert.rejects(() => sandbox.render(bad), /invalid cad request/);
  assert.equal(calls.length, 0);
});

test("a failing render returns the log and no model", async () => {
  const { docker } = fakeDocker({
    stdout: "",
    stderr: "ERROR: Parser error",
    status: 1,
  });
  const result = await createCadSandbox({ docker }).render({ scad: "cube(" });
  assert.equal(result.ok, false);
  assert.equal(result.stl, null);
  assert.match(result.log, /Parser error/);
});

test("a hung render is killed and removed", async () => {
  const { docker, calls } = fakeDocker({ hang: true });
  const result = await createCadSandbox({ docker }).render({
    scad: "while(true);",
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(calls.some((c) => c.path.endsWith("/kill")));
  assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("non-base64 output is never accepted as a model", async () => {
  const { docker } = fakeDocker({ stdout: "<script>" });
  const result = await createCadSandbox({ docker }).render({
    scad: "cube(1);",
  });
  assert.equal(result.ok, false);
  assert.equal(result.stl, null);
});
