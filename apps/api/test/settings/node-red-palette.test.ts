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

async function paletteServer(
  token = "fixture-admin-token-01234567890123456789",
) {
  let installed = false;
  let enabled = true;
  let writes = 0;
  let failReadback = false;
  let failAfterWrite = false;
  let failNextWrite = false;
  let deniedStatus = 0;
  const readAuthorizations: Array<string | undefined> = [];
  const leak = "private upstream token";
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/nodes" && request.method === "GET") {
      readAuthorizations.push(request.headers.authorization);
      if (deniedStatus) {
        response.statusCode = deniedStatus;
        response.end(JSON.stringify({ message: leak }));
        return;
      }
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
                  enabled,
                  loaded: true,
                  id: "node-red-node-suncalc/suncalc",
                  name: "suncalc",
                },
              ]
            : [],
        ),
      );
      return;
    }
    if (request.url === "/nodes" && request.method === "POST") {
      writes++;
      if (failNextWrite) {
        failNextWrite = false;
        response.statusCode = 503;
        response.end(JSON.stringify({ message: leak }));
        return;
      }
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
    nodeRedAdminToken: token,
    nodeRedPaletteAllowlist: '["node-red-node-suncalc"]',
  } as NovaConfig);
  return {
    management,
    readAuthorizations,
    denyReads: (status: number) => {
      deniedStatus = status;
    },
    writes: () => writes,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    failReadback: () => {
      failReadback = true;
    },
    failAfterWrite: () => {
      failAfterWrite = true;
    },
    failNextWrite: () => {
      failNextWrite = true;
    },
    leak,
  };
}

describe("Node-RED palette management", () => {
  it.each(["", "short-fixture-token"])(
    "uses actual HTTP authorization for token=%s",
    async (token) => {
      const fixture = await paletteServer(token);
      expect(
        (await fixture.management.paletteState()).modules[0]?.installed,
      ).toBe(false);
      expect(fixture.readAuthorizations).toEqual([
        token ? `Bearer ${token}` : undefined,
      ]);
      expect(fixture.writes()).toBe(0);
    },
  );

  it.each([401, 403])(
    "rejects actual Node-RED authorization status %s",
    async (status) => {
      const fixture = await paletteServer("");
      fixture.denyReads(status);
      await expect(fixture.management.paletteState()).rejects.toThrow(
        "niet veilig worden gelezen",
      );
      expect(fixture.readAuthorizations).toEqual([undefined]);
      expect(fixture.writes()).toBe(0);
      await expect(fixture.management.paletteState()).rejects.not.toThrow(
        fixture.leak,
      );
    },
  );

  it("rejects an overlapping mutation before delayed preflight and allows a fresh later change", async () => {
    const fixture = await paletteServer();
    const before = await fixture.management.paletteState();
    const original = fixture.management.paletteState.bind(fixture.management);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    const snapshot = vi
      .spyOn(fixture.management, "paletteState")
      .mockImplementation(async () => {
        if (!released) {
          await pending;
          return before;
        }
        return original();
      });
    const first = fixture.management.changePalette(
      "node-red-node-suncalc",
      true,
      before.revision,
    );
    const second = fixture.management
      .changePalette("node-red-node-suncalc", true, before.revision)
      .then(
        () => null,
        (error: unknown) => error,
      );
    released = true;
    release();
    const after = await first;
    const rejected = await second;
    expect(fixture.writes()).toBe(1);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain("bezig");
    expect(snapshot).toHaveBeenCalledTimes(2);
    await fixture.management.changePalette(
      "node-red-node-suncalc",
      false,
      after.revision,
    );
    expect(fixture.writes()).toBe(2);
  });

  it("releases the mutation guard after failed preflight and failed writes", async () => {
    const fixture = await paletteServer();
    const before = await fixture.management.paletteState();
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
    const snapshot = vi
      .spyOn(fixture.management, "paletteState")
      .mockRejectedValueOnce(new Error("synthetic preflight failure"));
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        true,
        before.revision,
      ),
    ).rejects.toThrow("synthetic preflight failure");
    snapshot.mockRestore();
    fixture.failNextWrite();
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        true,
        before.revision,
      ),
    ).rejects.toThrow("geweigerd");
    const after = await fixture.management.changePalette(
      "node-red-node-suncalc",
      true,
      before.revision,
    );
    expect(after.modules[0]?.installed).toBe(true);
    // A subsequent remove remains usable after the earlier error paths.
    await fixture.management.changePalette(
      "node-red-node-suncalc",
      false,
      after.revision,
    );
    expect(fixture.writes()).toBe(3);
  });

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
    fixture.setEnabled(false);
    await expect(
      fixture.management.changePalette(
        "node-red-node-suncalc",
        false,
        after.revision,
      ),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(1);
    const refreshed = await fixture.management.paletteState();
    expect(refreshed.revision).not.toBe(after.revision);
    const removed = await fixture.management.changePalette(
      "node-red-node-suncalc",
      false,
      refreshed.revision,
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
