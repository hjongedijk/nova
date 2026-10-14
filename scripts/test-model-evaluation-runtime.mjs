import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createEvaluationRuntime,
  createRunnerFactory,
} from "./model-evaluation-runtime.mjs";

for (const role of ["conversation", "code"]) {
  test(`${role} isolation checks the live boundary on every internal attempt and cleans scratch`, async () => {
    let liveAllowed = true;
    let networkAttempts = 0;
    let directory;
    const config = { dataFile: () => "/production/must-remain-untouched" };
    class RoutingService {
      constructor(isolated) {
        directory = path.dirname(isolated.dataFile("settings.json"));
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        const file = isolated.dataFile("settings.json");
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
          modelRoles: { [role]: { preferred: ["free/model"], fallback: null } },
        });
        assert.equal(
          fs.readFileSync(
            isolated.dataFile("free-routing-policy.json"),
            "utf8",
          ),
          "synthetic-policy",
        );
      }
      assertFree() {
        return { freeOnly: true };
      }
    }
    class OmniRouteClient {
      constructor(_config, routing) {
        this.routing = routing;
      }
      async call() {
        for (let attempt = 0; attempt < 2; attempt++) {
          this.routing.assertFree();
          networkAttempts++;
          // Simulates a live management marker appearing between internal attempts.
          liveAllowed = false;
        }
      }
    }
    const createRunner = createRunnerFactory({
      models: ["free/model"],
      role,
      config,
      policy: "synthetic-policy",
      RoutingService,
      OmniRouteClient,
      liveGate: () => {
        if (!liveAllowed) throw new Error("POLICY_BLOCKED");
      },
    });
    assert.throws(() => createRunner("free/unselected"), /POLICY_BLOCKED/);
    const runner = createRunner("free/model");
    try {
      await assert.rejects(runner.call(), /POLICY_BLOCKED/);
      assert.equal(networkAttempts, 1);
      assert.equal(
        config.dataFile("anything"),
        "/production/must-remain-untouched",
      );
      assert.throws(() => createRunner("free/model"), /POLICY_BLOCKED/);
    } finally {
      runner.close();
    }
    assert.equal(fs.existsSync(directory), false);
  });
}

test("runner construction failure removes private scratch without touching production paths", () => {
  let directory;
  class RoutingService {
    constructor(config) {
      directory = path.dirname(config.dataFile("settings.json"));
      throw new Error("synthetic initialization failure");
    }
  }
  const createRunner = createRunnerFactory({
    models: ["free/model"],
    role: "conversation",
    config: {},
    policy: "synthetic-policy",
    RoutingService,
    OmniRouteClient: class {},
    liveGate: () => {},
  });
  assert.throws(() => createRunner("free/model"), /initialization failure/);
  assert.equal(fs.existsSync(directory), false);
});

test("invalid role/model input fails before API initialization or configuration access", async () => {
  for (const [models, role] of [
    [["free/model"], "embedding"],
    [[], "code"],
    [["free/model", "free/model"], "conversation"],
    [["https://untrusted/model"], "conversation"],
  ]) {
    await assert.rejects(
      createEvaluationRuntime(models, role),
      /INVALID_ARGUMENTS/,
    );
  }
});
