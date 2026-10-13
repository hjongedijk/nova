import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { ADMIN, createApp } from "./helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function paletteServer() {
  let installed = false;
  let writes = 0;
  let failReadback = false;
  let failAfterWrite = false;
  const leak = "private upstream token";
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/nodes" && request.method === "GET") {
      if (failReadback) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: leak }));
        return;
      }
      response.end(
        JSON.stringify(
          installed
            ? [
                {
                  module: "node-red-node-suncalc",
                  version: "1.2.3",
                  types: ["suncalc"],
                  enabled: true,
                  id: "node-red-node-suncalc/suncalc",
                },
              ]
            : [],
        ),
      );
      return;
    }
    if (request.url === "/nodes" && request.method === "POST") {
      writes++;
      installed = true;
      if (failAfterWrite) failReadback = true;
      response.end(JSON.stringify({ name: "node-red-node-suncalc" }));
      return;
    }
    if (
      request.url === "/nodes/node-red-node-suncalc" &&
      request.method === "DELETE"
    ) {
      writes++;
      installed = false;
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: leak }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server unavailable");
  const management = new NodeRedManagement({
    nodeRedUrl: `http://127.0.0.1:${address.port}`,
    nodeRedAdminToken: "fixture-admin-token-01234567890123456789",
    nodeRedPaletteAllowlist: '["node-red-node-suncalc"]',
  } as NovaConfig);
  return {
    management,
    writes: () => writes,
    failReadback: () => {
      failReadback = true;
    },
    failAfterWrite: () => {
      failAfterWrite = true;
    },
    leak,
  };
}

describe("Node-RED palette management", () => {
  it("writes only allowlisted packages with a fresh snapshot and verifies readback", async () => {
    const fixture = await paletteServer();
    const before = await fixture.management.paletteState();
    expect(before.modules).toEqual([
      { name: "node-red-node-suncalc", installed: false, version: null },
    ]);
    await expect(
      fixture.management.changePalette(
        "node-red-node-other",
        true,
        before.revision,
      ),
    ).rejects.toThrow("niet toegestaan");
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        true,
        "0".repeat(64),
      ),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(0);
    const after = await fixture.management.changePalette(
      "node-red-node-suncalc",
      true,
      before.revision,
    );
    expect(after.modules[0]).toMatchObject({
      installed: true,
      version: "1.2.3",
    });
    expect(after.revision).not.toBe(before.revision);
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        false,
        before.revision,
      ),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(1);
    const removed = await fixture.management.changePalette(
      "node-red-node-suncalc",
      false,
      after.revision,
    );
    expect(removed.modules[0]?.installed).toBe(false);
    expect(fixture.writes()).toBe(2);
  });

  it("hides upstream errors and refuses an unverified install", async () => {
    const fixture = await paletteServer();
    const before = await fixture.management.paletteState();
    fixture.failAfterWrite();
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        true,
        before.revision,
      ),
    ).rejects.toThrow("mogelijk uitgevoerd");
    expect(fixture.writes()).toBe(1);
    await expect(fixture.management.paletteState()).rejects.not.toThrow(
      fixture.leak,
    );
  });

  it("refuses writes when inventory cannot be refreshed", async () => {
    const fixture = await paletteServer();
    const before = await fixture.management.paletteState();
    fixture.failReadback();
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        true,
        before.revision,
      ),
    ).rejects.toThrow();
    expect(fixture.writes()).toBe(0);
    await expect(fixture.management.paletteState()).rejects.not.toThrow(
      fixture.leak,
    );
  });

  it("requires SettingsGuard and fresh DANGEROUS confirmation", async () => {
    const app = await createApp({
      env: {
        NOVA_ADMIN_PIN: "fixture-pin",
        NODE_RED_PALETTE_ALLOWLIST: '["node-red-node-suncalc"]',
        NODE_RED_ADMIN_TOKEN: "fixture-admin-token-01234567890123456789",
      },
    });
    const management = app.app.get(NodeRedManagement);
    const state = {
      revision: "a".repeat(64),
      modules: [
        { name: "node-red-node-suncalc", installed: false, version: null },
      ],
    };
    const snapshot = vi
      .spyOn(management, "paletteState")
      .mockResolvedValue(state);
    const change = vi.spyOn(management, "changePalette").mockResolvedValue({
      revision: "b".repeat(64),
      modules: [
        { name: "node-red-node-suncalc", installed: true, version: "1.2.3" },
      ],
    });
    const pin = { ...ADMIN, "x-nova-pin": "fixture-pin" };
    const prepare = "/api/settings/node-red/palette/prepare";
    const confirm = "/api/settings/node-red/palette/confirm";
    const args = {
      module: "node-red-node-suncalc",
      install: true,
      revision: state.revision,
    };
    try {
      expect(
        (await app.api.get("/api/settings/node-red/palette").set(ADMIN)).status,
      ).toBe(401);
      expect(
        (
          await app.api
            .post(prepare)
            .set({ "x-nova-pin": "fixture-pin" })
            .send(args)
        ).status,
      ).toBe(403);
      expect(
        (
          await app.api
            .post(prepare)
            .set(pin)
            .send({ ...args, module: "node-red-node-other" })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const staged = await app.api.post(prepare).set(pin).send(args);
      expect(staged.status).toBe(200);
      expect(staged.body.action.risk).toBe("DANGEROUS");
      const action = staged.body.action;
      expect(
        (
          await app.api
            .post(confirm)
            .set(pin)
            .send({
              sessionId: action.sessionId,
              confirmationId: "0".repeat(36),
              approve: true,
            })
        ).body.ok,
      ).toBe(false);
      expect(change).not.toHaveBeenCalled();
      const accepted = await app.api.post(confirm).set(pin).send({
        sessionId: action.sessionId,
        confirmationId: action.confirmationId,
        approve: true,
      });
      expect(accepted.body.state.modules[0].installed).toBe(true);
      expect(change).toHaveBeenCalledWith(args.module, true, state.revision);
      expect(
        (
          await app.api.post(confirm).set(pin).send({
            sessionId: action.sessionId,
            confirmationId: action.confirmationId,
            approve: true,
          })
        ).body.ok,
      ).toBe(false);
      expect(snapshot).toHaveBeenCalled();
      expect(JSON.stringify(app.audits)).not.toContain("fixture-admin-token");
    } finally {
      await app.app.close();
    }
  });
});
