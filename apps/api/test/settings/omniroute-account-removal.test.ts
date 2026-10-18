import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteAccountRemovalController } from "../../src/settings/omniroute-account-removal.controller.js";
import { OmniRouteAccountRemoval } from "../../src/settings/omniroute-account-removal.service.js";

const verified: RoutingStatus = {
  ready: true,
  policyVerified: true,
  freeOnly: true,
  status: "VERIFIED_FREE_ROUTE",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-account-removal-"));
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY, provider TEXT, name TEXT, is_active INTEGER, updated_at TEXT); BEGIN",
  );
  const insert = db.prepare(
    "INSERT INTO provider_connections VALUES (?,?,?,?,?)",
  );
  insert.run(
    "account-1",
    "provider-1",
    "Bearer private-account-name",
    1,
    "revision-1",
  );
  insert.run("account-2", "provider-2", "Second account", 1, "revision-2");
  db.exec("COMMIT");
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    freeOnly: false,
    dataFile: (name: string) => path.join(dir, name),
  };
  const marker = config.dataFile("free-routing-management-block.json");
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const routing = new RoutingService(config as NovaConfig);
  const verify = vi
    .spyOn(routing, "verifyForManagement")
    .mockReturnValue(verified);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  const configured = vi.fn(() => true);
  const deleted = (id: string) => {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM provider_connections WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const row = (id = "account-1") =>
    db.prepare("SELECT * FROM provider_connections WHERE id=?").get(id);
  const request = vi.fn(
    async (endpoint: string, options: { method: string }) => {
      expect(options).toEqual({ method: "DELETE" });
      expect(routing.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
      expect(new RoutingService(config as NovaConfig).status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
        version: 1,
        reason: "account_change",
      });
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
      deleted(endpoint.split("/").at(-1)!);
      return { ok: true };
    },
  );
  const management = {
    get configured() {
      return configured();
    },
    request,
  };
  const removal = new OmniRouteAccountRemoval(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    audit,
    barrier,
    routing,
  );
  const expectBlocked = () => {
    expect(fs.existsSync(marker)).toBe(true);
    for (const instance of [
      routing,
      new RoutingService(config as NovaConfig),
    ]) {
      expect(instance.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => instance.assertFree()).toThrow(FreeRoutingBlockedError);
    }
  };
  return {
    dir,
    db,
    config,
    marker,
    record,
    routing,
    verify,
    barrier,
    configured,
    deleted,
    row,
    request,
    removal,
    expectBlocked,
  };
}

describe("OmniRoute account removal (single step)", () => {
  it("blocks memory and disk before DELETE and releases only after persisted removal and two fresh route checks", async () => {
    const f = fixture();
    f.verify.mockImplementation(() => {
      expect(f.row()).toBeUndefined();
      f.expectBlocked();
      return verified;
    });
    expect(await f.removal.remove("account-1")).toEqual({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(f.request.mock.calls).toEqual([
      ["/api/providers/account-1", { method: "DELETE" }],
    ]);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.row()).toBeUndefined();
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.routing.assertFree().ready).toBe(true);
    expect(new RoutingService(f.config as NovaConfig).assertFree().ready).toBe(
      true,
    );
    expect(await f.removal.remove("account-1")).toMatchObject({ ok: false });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "after_execute",
        confirmation: "direct",
        verification: { persisted: true, routeReady: true },
      }),
    );
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "private-account-name",
    );
  });

  it("only deletes the requested account", async () => {
    const f = fixture();
    await f.removal.remove("account-1");
    expect(f.row("account-2")).toBeDefined();
  });

  it("reports a missing account without any write", async () => {
    const f = fixture();
    expect(await f.removal.remove("missing")).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it.each(["provenance", "configured", "database"])(
    "checks %s before DELETE",
    async (failure) => {
      const f = fixture();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "configured") f.configured.mockReturnValue(false);
      if (failure === "database") f.config.omniDatabase += ".missing";
      expect(await f.removal.remove("account-1")).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it("refuses a concurrent removal during a delayed DELETE, then frees operation ownership", async () => {
    const f = fixture();
    const persist = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async (endpoint, options) => {
      f.expectBlocked();
      await gate;
      return persist(endpoint, options);
    });
    const pending = f.removal.remove("account-1");
    try {
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(await f.removal.remove("account-2")).toMatchObject({ ok: false });
      expect(f.row("account-2")).toBeDefined();
      expect(f.request).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ ok: true, verified: true });
    expect(await f.removal.remove("account-2")).toMatchObject({
      ok: true,
      verified: true,
    });
  });

  it.each(["echo", "upstream-after-delete"])(
    "keeps inference durably blocked after unverified deletion: %s",
    async (failure) => {
      const f = fixture();
      f.request.mockImplementation(async () => {
        f.expectBlocked();
        if (failure === "upstream-after-delete") {
          f.deleted("account-1");
          throw new Error("fixture upstream failure");
        }
        return { ok: true };
      });
      expect(await f.removal.remove("account-1")).toMatchObject({
        ok: false,
        verified: null,
        routeReady: false,
      });
      expect(Boolean(f.row())).toBe(failure === "echo");
      f.expectBlocked();
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          verification: { persisted: null, routeReady: false },
        }),
      );
    },
  );

  it.each([
    "not-ready",
    "not-free",
    "not-verified",
    "throws",
    "second-check-fails",
  ])("retains the marker when route proof %s", async (failure) => {
    const f = fixture();
    if (failure === "throws")
      f.verify.mockImplementation(() => {
        throw new Error("fixture route failure");
      });
    else if (failure === "second-check-fails")
      f.verify
        .mockReturnValueOnce(verified)
        .mockReturnValue({ ...verified, ready: false });
    else
      f.verify.mockReturnValue({
        ...verified,
        ready: failure !== "not-ready",
        freeOnly: failure !== "not-free",
        policyVerified: failure !== "not-verified",
      });
    expect(await f.removal.remove("account-1")).toEqual({
      ok: true,
      verified: true,
      routeReady: false,
    });
    expect(f.row()).toBeUndefined();
    f.expectBlocked();
    expect(f.verify).toHaveBeenCalledTimes(
      failure === "second-check-fails" ? 2 : 1,
    );
    f.verify.mockReturnValue(verified);
    await f.barrier.run(async (operation) => {
      expect(operation.releaseAfterVerification()).toEqual(verified);
    });
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.routing.assertFree().ready).toBe(true);
  });

  it("pre-execution audit failure blocks DELETE", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "before_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.removal.remove("account-1")).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.row()).toBeDefined();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("reports verified removal honestly with a final audit warning", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "after_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.removal.remove("account-1")).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
      auditWarning: expect.any(String),
    });
    expect(f.row()).toBeUndefined();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("prevents DELETE and retains the in-memory inference stop when marker persistence fails", async () => {
    const f = fixture();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("fixture marker failure");
    });
    expect(await f.removal.remove("account-1")).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.row()).toBeDefined();
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(f.verify).not.toHaveBeenCalled();
  });
});

describe("account removal validation and API boundary", () => {
  it.each(["../account", "account?x=1", "", "a".repeat(101)])(
    "rejects malformed account id %s",
    async (id) => {
      const f = fixture();
      await expect(f.removal.remove(id)).rejects.toThrow(ValidationError);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("accepts an empty body and rejects extra fields before delegation", () => {
    const service = { remove: vi.fn() };
    const controller = new OmniRouteAccountRemovalController(
      service as unknown as OmniRouteAccountRemoval,
    );
    for (const body of [null, [], { acknowledgeEffects: true }, { always: 1 }])
      if (body === null) controller.remove("account-1", body);
      else
        expect(() => controller.remove("account-1", body)).toThrow(
          ValidationError,
        );
    expect(service.remove).toHaveBeenCalledTimes(1);
    controller.remove("account-1", {});
    expect(service.remove).toHaveBeenCalledTimes(2);
  });
});
