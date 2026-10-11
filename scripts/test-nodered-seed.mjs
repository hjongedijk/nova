import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "nova-node-red-seed-"));
const data = join(root, "data");
const entrypoint = join(root, "node-red-entrypoint");
const seed = resolve("deploy/nodered");

try {
  mkdirSync(data);
  writeFileSync(
    entrypoint,
    '#!/bin/sh\nprintf started > "$NOVA_NODE_RED_DATA_DIR/started"\n',
  );
  chmodSync(entrypoint, 0o755);
  const env = {
    ...process.env,
    NOVA_NODE_RED_DATA_DIR: data,
    NOVA_NODE_RED_ENTRYPOINT: entrypoint,
    NOVA_NODE_RED_SEED_DIR: seed,
  };
  const run = () =>
    spawnSync("sh", [join(seed, "seed-entrypoint.sh")], {
      env,
      encoding: "utf8",
    });

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  for (const file of ["flows.json", "settings.js"]) {
    assert.equal(
      readFileSync(join(data, file), "utf8"),
      readFileSync(join(seed, file), "utf8"),
    );
  }
  const installedManifest = JSON.parse(
    readFileSync(join(data, "package.json"), "utf8"),
  );
  assert.equal(installedManifest.name, "nova-node-red-userdir");
  assert.equal(
    resolve(
      data,
      installedManifest.dependencies["node-red-contrib-nova"].replace(
        /^file:/,
        "",
      ),
    ),
    resolve(seed, "node-red-contrib-nova"),
  );
  assert.ok(
    existsSync(join(data, "node_modules/node-red-contrib-nova/package.json")),
    "the local NOVA module must install into the persistent user directory",
  );

  const editedFlows = '[{"id":"operator-flow"}]\n';
  writeFileSync(join(data, "flows.json"), editedFlows);
  writeFileSync(join(data, "flows_cred.json"), '{"encrypted":true}\n');
  writeFileSync(
    join(data, "package.json"),
    '{"dependencies":{"operator-node":"1.2.3"}}\n',
  );
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(data, "flows.json"), "utf8"), editedFlows);
  assert.equal(
    readFileSync(join(data, "flows_cred.json"), "utf8"),
    '{"encrypted":true}\n',
  );
  assert.equal(
    readFileSync(join(data, "package.json"), "utf8"),
    '{"dependencies":{"operator-node":"1.2.3"}}\n',
  );
  assert.equal(readFileSync(join(data, "started"), "utf8"), "started");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "Node-RED seed initializes missing files and preserves operator data on restart.",
);
