import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCodeSandbox } from "../deploy/stack-control/code-sandbox.mjs";
import { dockerRequest } from "../deploy/stack-control/server.mjs";

const image = process.env.NOVA_SANDBOX_TEST_IMAGE ?? "nova:sandbox-check";
const inspect = spawnSync(
  "docker",
  ["image", "inspect", image, "--format", "{{.Id}}"],
  { encoding: "utf8" },
);
if (inspect.status !== 0)
  throw new Error(`Build the sandbox image first: ${inspect.stderr.trim()}`);
const imageId = inspect.stdout.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
  throw new Error("Docker did not return an immutable image ID");

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "nova-sandbox-runtime-"),
);
const workspaceRoot = path.join(dataRoot, "workspace");
const projectRoot = path.join(workspaceRoot, "smoke-project");
fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
fs.chownSync(workspaceRoot, 1000, 1000);
fs.chownSync(projectRoot, 1000, 1000);

const fakeContainers = [
  { Id: "fixture-nova", Names: ["/nova"] },
  { Id: "fixture-broker", Names: ["/nova-stack-control"] },
];
const docker = async (url, method = "GET", body, options) => {
  if (url.startsWith("/containers/json?all=1")) return fakeContainers;
  if (url === "/containers/fixture-nova/json")
    return {
      Image: imageId,
      Mounts: [{ Type: "bind", Source: dataRoot, Destination: "/data" }],
    };
  if (url === "/containers/fixture-broker/json")
    return {
      Mounts: [
        { Type: "bind", Source: workspaceRoot, Destination: "/workspace-host" },
      ],
    };
  return dockerRequest(url, method, body, options);
};

try {
  const sandbox = createCodeSandbox({ docker, workspaceRoot });
  const probe = [
    "const fs=require('node:fs');",
    "const os=require('node:os');",
    "fs.writeFileSync('/workspace/sandbox-result.txt','written inside project');",
    "let dataWritable=true;try{fs.writeFileSync('/data/probe','no')}catch{dataWritable=false}",
    "const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n');",
    "const root=mounts.find(x=>x.split(' ')[4]==='/');",
    "console.log(JSON.stringify({uid:process.getuid(),network:Object.keys(os.networkInterfaces()).sort(),hasGatewayKey:Boolean(process.env.OMNIROUTE_API_KEY),dataFiles:fs.readdirSync('/data'),dataWritable,rootReadOnly:root?.split(' ')[5]?.split(',').includes('ro')===true,memoryLimit:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),cpuLimit:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),pidsLimit:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}));",
  ].join("");
  const result = await sandbox.run({
    projectId: "smoke-project",
    command: ["node", "-e", probe],
  });
  assert.equal(result.ok, true, result.output);
  const report = JSON.parse(result.output.trim());
  assert.deepEqual(report, {
    uid: 1000,
    network: ["lo"],
    hasGatewayKey: false,
    dataFiles: [],
    dataWritable: false,
    rootReadOnly: true,
    memoryLimit: String(256 * 1024 * 1024),
    cpuLimit: "50000 100000",
    pidsLimit: "64",
  });
  assert.equal(
    fs.readFileSync(path.join(projectRoot, "sandbox-result.txt"), "utf8"),
    "written inside project",
  );

  const startedAt = Date.now();
  const timedOut = await sandbox.run({
    projectId: "smoke-project",
    command: ["node", "-e", "setTimeout(() => {}, 60000)"],
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.ok, false);
  assert.ok(elapsed >= 30_000 && elapsed < 40_000, `timeout took ${elapsed}ms`);
  console.log(
    `Real Docker sandbox isolation and timeout passed (${elapsed}ms).`,
  );
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
