import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

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
  allowlist: unknown = ["node-red-node-suncalc"],
) {
  let installed = false;
  let enabled = true;
  let writes = 0;
  let failReadback = false;
  let failAfterWrite = false;
  let failNextWrite = false;
  let deniedStatus = 0;
  let installedVersion: string | undefined = "1.2.3";
  let readbackOverride: { version: string | undefined } | undefined;
  let readbackVersions: Array<string | undefined> | undefined;
  let pendingVersions: unknown[] | undefined;
  let pendingUpgrade:
    { active: Array<string | undefined>; pending: unknown[] } | undefined;
  const payloads: unknown[] = [];
  const readAuthorizations: Array<string | undefined> = [];
  const leak = "private upstream token";
  const server = http.createServer(async (request, response) => {
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
            ? (
                readbackVersions ?? [
                  readbackOverride
                    ? readbackOverride.version
                    : installedVersion,
                ]
              ).map((version, index) => ({
                module: "node-red-node-suncalc",
                version,
                pending_version: pendingVersions?.[index],
                types: ["suncalc"],
                enabled,
                loaded: true,
                id: `node-red-node-suncalc/suncalc${index ? index : ""}`,
                name: "suncalc",
              }))
            : [],
        ),
      );
      return;
    }
    if (request.url === "/nodes" && request.method === "POST") {
      writes++;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      payloads.push(payload);
      if (failNextWrite) {
        failNextWrite = false;
        response.statusCode = 503;
        response.end(JSON.stringify({ message: leak }));
        return;
      }
      installed = true;
      installedVersion = payload.version ?? "1.2.3";
      if (pendingUpgrade) {
        readbackVersions = pendingUpgrade.active;
        pendingVersions = pendingUpgrade.pending;
      }
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
  const config = {
    nodeRedUrl: `http://127.0.0.1:${address.port}`,
    nodeRedAdminToken: token,
    nodeRedPaletteAllowlist: JSON.stringify(allowlist),
  };
  const management = new NodeRedManagement(config as NovaConfig);
  return {
    management,
    config,
    payloads,
    setInstalled: (version: string | undefined) => {
      installed = true;
      installedVersion = version;
    },
    setReadbackVersion: (version: string | undefined) => {
      readbackOverride = { version };
    },
    setReadbackVersions: (versions: Array<string | undefined>) => {
      readbackVersions = versions;
    },
    setPendingVersions: (versions: unknown[]) => {
      pendingVersions = versions;
    },
    setPendingUpgrade: (
      active: Array<string | undefined>,
      pending: unknown[],
    ) => {
      pendingUpgrade = { active, pending };
    },
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
  const packageName = "node-red-node-suncalc";
  it.each([
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha",
    "1.2.3-0",
    "1.2.3-rc.1+build.001",
    "1.2.3-01a",
    "1.2.3-x-y.01a+foo-bar",
  ])(
    "installs the exact approved SemVer %s and verifies its readback",
    async (version) => {
      const fixture = await paletteServer("", [{ name: packageName, version }]);
      const before = await fixture.management.paletteState();
      expect(before.modules[0]?.targetVersion).toBe(version);
      const after = await fixture.management.changePalette(
        packageName,
        true,
        before.revision,
      );
      expect(fixture.payloads).toEqual([{ module: packageName, version }]);
      expect(after.modules[0]).toMatchObject({
        installed: true,
        version,
        targetVersion: version,
      });
    },
  );

  it.each([
    "",
    "latest",
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3",
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-a..b",
    "1.2.3-",
    "1.2.3+",
    "1.2.3+a..b",
    "1.2.3 beta",
    "1.2.3\n",
    "https://example.test/pkg.tgz",
    "file:/tmp/pkg",
    "1.2.3+" + "a".repeat(60),
  ])(
    "rejects non-exact or malformed target version %# before any Node-RED request",
    async (version) => {
      const fixture = await paletteServer("", [{ name: packageName, version }]);
      await expect(fixture.management.paletteState()).rejects.toThrow(
        "ongeldig ingesteld",
      );
      expect(fixture.readAuthorizations).toEqual([]);
      expect(fixture.writes()).toBe(0);
    },
  );

  it.each(
    [
      null,
      {},
      [null],
      [123],
      [[]],
      [{ name: packageName }],
      [{ name: packageName, version: null }],
      [{ name: packageName, version: "1.2.3", extra: true }],
      [{ name: "node-red", version: "1.2.3" }],
      [{ name: "@scope/node-red-node-example", version: "1.2.3" }],
      [packageName, { name: packageName, version: "1.2.3" }],
      [
        { name: packageName, version: "1.2.3" },
        { name: packageName, version: "2.0.0" },
      ],
      Array.from(
        { length: 21 },
        (_, index) => `node-red-node-fixture-${index}`,
      ),
    ].map((allowlist) => ({ allowlist })),
  )(
    "rejects malformed or duplicate palette policy case %#",
    async ({ allowlist }) => {
      const fixture = await paletteServer("", allowlist);
      await expect(fixture.management.paletteState()).rejects.toThrow(
        "ongeldig ingesteld",
      );
      expect(fixture.readAuthorizations).toEqual([]);
      expect(fixture.writes()).toBe(0);
    },
  );

  it.each([undefined, "9.9.9"])(
    "refuses an installation whose observed version is %s",
    async (observed) => {
      const fixture = await paletteServer("", [
        { name: packageName, version: "1.2.3" },
      ]);
      const before = await fixture.management.paletteState();
      fixture.setReadbackVersion(observed);
      await expect(
        fixture.management.changePalette(packageName, true, before.revision),
      ).rejects.toThrow("niet bevestigd");
      expect(fixture.writes()).toBe(1);
    },
  );

  it.each([
    { versions: ["9.9.9", "1.2.3"] },
    { versions: ["1.2.3", "9.9.9"] },
    { versions: ["1.2.3", undefined] },
    { versions: [undefined, "1.2.3"] },
    { versions: ["1.2.3", "9.9.9", "1.2.3"] },
    { versions: ["1.2.3", "invalid version", "1.2.3"] },
    { versions: [undefined, undefined] },
  ])(
    "never verifies a pinned installation from conflicting or incomplete module rows case %#",
    async ({ versions }) => {
      const fixture = await paletteServer("", [
        { name: packageName, version: "1.2.3" },
      ]);
      const before = await fixture.management.paletteState();
      fixture.setReadbackVersions(versions);
      await expect(
        fixture.management.changePalette(packageName, true, before.revision),
      ).rejects.toThrow("niet bevestigd");
      expect(fixture.writes()).toBe(1);
      expect(
        (await fixture.management.paletteState()).modules[0],
      ).toMatchObject({ installed: true, version: null });
    },
  );

  it("verifies identical valid versions across multiple node sets", async () => {
    const fixture = await paletteServer("", [
      { name: packageName, version: "1.2.3" },
    ]);
    const before = await fixture.management.paletteState();
    fixture.setReadbackVersions(["1.2.3", "1.2.3", "1.2.3"]);
    const after = await fixture.management.changePalette(
      packageName,
      true,
      before.revision,
    );
    expect(after.modules[0]).toMatchObject({
      installed: true,
      version: "1.2.3",
      targetVersion: "1.2.3",
    });
    expect(fixture.writes()).toBe(1);
  });

  it.each([
    { active: ["1.2.3"], pending: ["2.0.0"] },
    { active: ["1.2.3", "1.2.3"], pending: ["2.0.0", "2.0.0"] },
    { active: [undefined, undefined], pending: ["2.0.0", "2.0.0"] },
  ])(
    "accepts a consistently staged exact upgrade without claiming it is already active case %#",
    async ({ active, pending }) => {
      const fixture = await paletteServer("", [
        { name: packageName, version: "2.0.0" },
      ]);
      fixture.setInstalled("1.2.3");
      const before = await fixture.management.paletteState();
      fixture.setPendingUpgrade(active, pending);
      const after = await fixture.management.changePalette(
        packageName,
        true,
        before.revision,
      );
      expect(after.modules[0]).toMatchObject({
        installed: true,
        version: active[0] ?? null,
        pendingVersion: "2.0.0",
        restartRequired: true,
      });
      expect(after.revision).not.toBe(before.revision);
      await expect(
        fixture.management.changePalette(packageName, true, after.revision),
      ).rejects.toThrow("gewijzigd");
      expect(fixture.writes()).toBe(1);
      await fixture.management.changePalette(
        packageName,
        false,
        after.revision,
      );
      expect(fixture.writes()).toBe(2);
    },
  );

  it.each([
    { pending: ["2.0.0", undefined] },
    { pending: [undefined, "2.0.0"] },
    { pending: ["9.9.9", "2.0.0"] },
    { pending: ["2.0.0", "9.9.9", "2.0.0"] },
    { pending: ["2.0.0", "invalid version", "2.0.0"] },
    { pending: [true] },
  ])(
    "rejects staged mismatch or incomplete pending evidence even if active rows equal the pin case %#",
    async ({ pending }) => {
      const fixture = await paletteServer("", [
        { name: packageName, version: "2.0.0" },
      ]);
      const before = await fixture.management.paletteState();
      fixture.setPendingUpgrade(
        pending.map(() => "2.0.0"),
        pending,
      );
      await expect(
        fixture.management.changePalette(packageName, true, before.revision),
      ).rejects.toThrow("niet bevestigd");
      const after = await fixture.management.paletteState();
      expect(after.modules[0]).toMatchObject({
        version: "2.0.0",
        pendingVersion: null,
        restartRequired: true,
      });
      await expect(
        fixture.management.changePalette(packageName, true, after.revision),
      ).rejects.toThrow("gewijzigd");
      expect(fixture.writes()).toBe(1);
    },
  );

  it("includes pending evidence in the revision and blocks writes while a restart is required", async () => {
    const fixture = await paletteServer("", [
      { name: packageName, version: "2.0.0" },
    ]);
    fixture.setInstalled("1.2.3");
    fixture.setReadbackVersions(["1.2.3", "1.2.3"]);
    const before = await fixture.management.paletteState();
    fixture.setPendingVersions(["2.0.0", undefined]);
    const changed = await fixture.management.paletteState();
    expect(changed.revision).not.toBe(before.revision);
    expect(changed.modules[0]).toMatchObject({
      pendingVersion: null,
      restartRequired: true,
    });
    await expect(
      fixture.management.changePalette(packageName, true, before.revision),
    ).rejects.toThrow("gewijzigd");
    await expect(
      fixture.management.changePalette(packageName, true, changed.revision),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(0);
  });

  it("upgrades a pinned module but rejects an already matching target", async () => {
    const fixture = await paletteServer("", [
      { name: packageName, version: "2.0.0" },
    ]);
    fixture.setInstalled("1.2.3");
    const before = await fixture.management.paletteState();
    const after = await fixture.management.changePalette(
      packageName,
      true,
      before.revision,
    );
    expect(fixture.payloads).toEqual([
      { module: packageName, version: "2.0.0" },
    ]);
    expect(after.modules[0]?.version).toBe("2.0.0");
    await expect(
      fixture.management.changePalette(packageName, true, after.revision),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(1);
    await fixture.management.changePalette(packageName, false, after.revision);
    expect(fixture.writes()).toBe(2);
  });

  it("rejects confirmations after the approved target version or policy changes", async () => {
    const fixture = await paletteServer("", [
      { name: packageName, version: "1.2.3" },
    ]);
    const before = await fixture.management.paletteState();
    fixture.config.nodeRedPaletteAllowlist = JSON.stringify([
      { name: packageName, version: "2.0.0" },
    ]);
    await expect(
      fixture.management.changePalette(packageName, true, before.revision),
    ).rejects.toThrow("gewijzigd");
    const changed = await fixture.management.paletteState();
    expect(changed.revision).not.toBe(before.revision);
    fixture.config.nodeRedPaletteAllowlist = JSON.stringify([packageName]);
    await expect(
      fixture.management.changePalette(packageName, true, changed.revision),
    ).rejects.toThrow("gewijzigd");
    expect(fixture.writes()).toBe(0);
  });

  it("hashes normalized policy independently of object-key and allowlist order", async () => {
    const first = { name: packageName, version: "1.2.3" };
    const second = "node-red-node-other";
    const fixture = await paletteServer("", [first, second]);
    const before = await fixture.management.paletteState();
    fixture.config.nodeRedPaletteAllowlist = JSON.stringify([
      second,
      { version: "1.2.3", name: packageName },
    ]);
    expect((await fixture.management.paletteState()).revision).toBe(
      before.revision,
    );
  });

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
      {
        name: "node-red-node-suncalc",
        installed: false,
        version: null,
        targetVersion: null,
        pendingVersion: null,
        restartRequired: false,
      },
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
    expect(fixture.payloads).toEqual([{ module: packageName }]);
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
});
