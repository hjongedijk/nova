import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodeSandbox } from "../deploy/stack-control/code-sandbox.mjs";
import { createStackControlServer } from "../deploy/stack-control/server.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-code-sandbox-"));
try {
  const workspaceRoot = path.join(temp, "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "demo-project"), { recursive: true });
  const calls = [];
  const frame = (stream, value) => {
    const data = Buffer.from(value);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  const docker = async (url, method = "GET", body, options = {}) => {
    calls.push({ url, method, body, options });
    if (url.startsWith("/containers/json"))
      return [
        { Id: "nova-id", Names: ["/nova"] },
        { Id: "broker-id", Names: ["/nova-stack-control"] },
      ];
    if (url === "/containers/nova-id/json")
      return {
        Image: `sha256:${"a".repeat(64)}`,
        Mounts: [{ Type: "bind", Source: temp, Destination: "/data" }],
      };
    if (url === "/containers/broker-id/json")
      return {
        Mounts: [
          {
            Type: "bind",
            Source: workspaceRoot,
            Destination: "/workspace-host",
          },
        ],
      };
    if (url.startsWith("/containers/create?")) return { Id: "sandbox-id" };
    if (url.endsWith("/wait?condition=not-running")) return { StatusCode: 0 };
    if (url.endsWith("/logs?stdout=1&stderr=1&timestamps=0"))
      return Buffer.concat([frame(1, "tests passed\n"), frame(2, "notice\n")]);
    return null;
  };

  const result = await createCodeSandbox({ docker, workspaceRoot }).run({
    projectId: "demo-project",
    command: ["npm", "test"],
  });
  assert.deepEqual(result, {
    ok: true,
    statusCode: 0,
    timedOut: false,
    output: "tests passed\nnotice\n",
    truncated: false,
  });
  const createCall = calls.find((call) =>
    call.url.startsWith("/containers/create?"),
  );
  assert.ok(createCall);
  assert.equal(createCall.body.Image, `sha256:${"a".repeat(64)}`);
  assert.equal(createCall.body.User, "1000:1000");
  assert.equal(createCall.body.HostConfig.NetworkMode, "none");
  assert.equal(createCall.body.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(createCall.body.HostConfig.CapDrop, ["ALL"]);
  assert.equal(createCall.body.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(createCall.body.HostConfig.PidsLimit, 64);
  assert.equal(
    createCall.body.HostConfig.Tmpfs["/data"],
    "ro,noexec,nosuid,nodev,size=1m",
  );
  assert.equal(createCall.body.HostConfig.Binds, undefined);
  assert.deepEqual(createCall.body.Env, [
    "HOME=/tmp",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "NODE_ENV=development",
  ]);
  assert.deepEqual(createCall.body.HostConfig.Mounts, [
    {
      Type: "bind",
      Source: path.join(workspaceRoot, "demo-project"),
      Target: "/workspace",
      ReadOnly: false,
    },
  ]);
  assert.ok(calls.some((call) => call.url.endsWith("/sandbox-id?force=1&v=1")));

  const timeoutCalls = [];
  const timeoutDocker = async (url, method, body, options) => {
    timeoutCalls.push(url);
    if (url.endsWith("/wait?condition=not-running"))
      throw new Error("Docker timeout");
    if (url.endsWith("/logs?stdout=1&stderr=1&timestamps=0"))
      return frame(2, "Time limit reached");
    return docker(url, method, body, options);
  };
  const timedOut = await createCodeSandbox({
    docker: timeoutDocker,
    workspaceRoot,
  }).run({ projectId: "demo-project", command: ["npm", "test"] });
  assert.deepEqual(timedOut, {
    ok: false,
    statusCode: null,
    timedOut: true,
    output: "Time limit reached",
    truncated: false,
  });
  assert.ok(timeoutCalls.some((url) => url.endsWith("/kill")));

  const noisyDocker = async (url, method, body, options) => {
    if (url.endsWith("/logs?stdout=1&stderr=1&timestamps=0"))
      return frame(1, "x".repeat(40 * 1024));
    return docker(url, method, body, options);
  };
  const noisy = await createCodeSandbox({
    docker: noisyDocker,
    workspaceRoot,
  }).run({ projectId: "demo-project", command: ["npm", "test"] });
  assert.equal(Buffer.byteLength(noisy.output), 32 * 1024);
  assert.equal(noisy.truncated, true);

  let routeDockerCalls = 0;
  const routeServer = createStackControlServer({
    token: "a".repeat(64),
    workspaceRoot,
    docker: async (...args) => {
      routeDockerCalls++;
      return docker(...args);
    },
  });
  await new Promise((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = routeServer.address();
    const endpoint = `http://127.0.0.1:${address.port}/code/run`;
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "demo-project",
        command: ["npm", "test"],
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(routeDockerCalls, 0);
    const authorized = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(64)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "demo-project",
        command: ["npm", "test"],
      }),
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), result);
  } finally {
    await new Promise((resolve, reject) =>
      routeServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  for (const invalid of [
    { projectId: "../nova-data", command: ["npm", "test"] },
    { projectId: "demo-project", command: ["npm", "x".repeat(1025)] },
    { projectId: "demo-project", command: ["npm", "test"], network: true },
  ])
    await assert.rejects(
      createCodeSandbox({ docker, workspaceRoot }).run(invalid),
    );

  const symlink = path.join(workspaceRoot, "linked-project");
  fs.symlinkSync(path.join(workspaceRoot, "demo-project"), symlink, "dir");
  await assert.rejects(
    createCodeSandbox({ docker, workspaceRoot }).run({
      projectId: "linked-project",
      command: ["npm", "test"],
    }),
  );
  console.log("Code sandbox isolation checks passed.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
