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
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteAccountActivation } from "../../src/settings/omniroute-account-activation.service.js";
import { OmniRouteActivationHistory } from "../../src/settings/omniroute-activation-history.service.js";
import { dbStat } from "../helpers/nova-db.js";

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

function fixture(initialActive = true) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-account-activation-"),
  );
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,is_active INTEGER,updated_at TEXT)",
  );
  db.prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)").run(
    "account-1",
    "provider-1",
    "Friendly account",
    Number(initialActive),
    "rev-1",
  );
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    dataFile: (name: string) => path.join(dir, name),
  };
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const routing = new RoutingService(config as NovaConfig);
  vi.spyOn(routing, "verifyForManagement").mockImplementation(() => {
    const state = db
      .prepare(
        "SELECT is_active FROM provider_connections WHERE id='account-1'",
      )
      .get() as { is_active: number };
    return state.is_active === 1
      ? verified
      : {
          ready: false,
          policyVerified: false,
          freeOnly: true,
          status: "POLICY_DRIFT_BLOCKED",
        };
  });
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  let persisted = true;
  const request = vi.fn(
    async (endpoint: string, options?: { method?: string; body?: unknown }) => {
      expect(endpoint).toBe("/api/providers/account-1");
      if (options?.method === "PATCH") {
        const enabled = (options.body as { isActive: boolean }).isActive;
        expect(options.body).toEqual({ isActive: enabled });
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persisted)
          db.prepare(
            "UPDATE provider_connections SET is_active=?,updated_at='rev-2' WHERE id='account-1'",
          ).run(Number(enabled));
        return {};
      }
      const row = db
        .prepare(
          "SELECT id,provider,name,is_active FROM provider_connections WHERE id='account-1'",
        )
        .get() as {
        id: string;
        provider: string;
        name: string;
        is_active: number;
      };
      return {
        connection: {
          id: row.id,
          provider: row.provider,
          name: row.name,
          isActive: row.is_active === 1,
          apiKey: "must-not-leak",
        },
      };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const history = new OmniRouteActivationHistory(config as NovaConfig);
  const activation = new OmniRouteAccountActivation(
    config as NovaConfig,
    management,
    audit,
    barrier,
    routing,
    history,
  );
  return {
    dir,
    activation,
    history,
    db,
    request,
    record,
    routing,
    setPersisted: (value: boolean) => {
      persisted = value;
    },
  };
}

describe("OmniRoute provider account activation (single step)", () => {
  it("rejects invalid input, never exposes credentials and needs no confirmation", async () => {
    const f = fixture();
    await expect(
      f.activation.set("account-1", "nope" as unknown as boolean),
    ).rejects.toThrow("geldige");
    expect(f.request).not.toHaveBeenCalled();
    const result = await f.activation.set("account-1", false);
    expect(result).toMatchObject({ ok: true, verified: true, enabled: false });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(
      f.record.mock.calls.every(([r]) => r.confirmation === "direct"),
    ).toBe(true);
  });

  it("writes only isActive under the routing barrier and verifies local and gateway state", async () => {
    const f = fixture();
    const result = await f.activation.set("account-1", false);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      enabled: false,
      routeReady: false,
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(f.request).toHaveBeenCalledWith("/api/providers/account-1", {
      method: "PATCH",
      body: { isActive: false },
    });
    expect(
      f.db
        .prepare(
          "SELECT is_active FROM provider_connections WHERE id='account-1'",
        )
        .get(),
    ).toEqual({ is_active: 0 });
    const phases = f.record.mock.calls.map(([record]) => record.phase);
    expect(phases).toContain("before_execute");
    expect(phases).toContain("after_execute");
    const history = f.history.list("account-1");
    expect(history.revisions).toMatchObject([
      {
        kind: "account",
        entityId: "account-1",
        name: "Friendly account",
        beforeEnabled: true,
        afterEnabled: false,
      },
    ]);
    expect(JSON.stringify(history)).not.toContain("must-not-leak");
    expect(
      dbStat(path.join(f.dir, "omniroute-account-activation-history.json"))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("reports a no-op toggle without writing", async () => {
    const f = fixture();
    const result = await f.activation.set("account-1", true);
    expect(result).toMatchObject({ ok: false });
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
  });

  it("restores the latest account status in one step", async () => {
    const f = fixture();
    expect((await f.activation.set("account-1", false)).ok).toBe(true);
    const latest = f.history.list("account-1").revisions[0]!;
    const target = f.history.rollbackTarget("account-1", latest.id);
    const result = await f.activation.set(
      "account-1",
      target.enabled,
      target.expectedCurrentRevision,
    );
    expect(result).toMatchObject({ ok: true, verified: true, enabled: true });
    expect(f.history.list("account-1").revisions).toHaveLength(2);
    expect(() => f.history.rollbackTarget("account-1", latest.id)).toThrow(
      "nieuwste wijziging",
    );
  });

  it("refuses rollback after an external upstream account change", async () => {
    const f = fixture();
    await f.activation.set("account-1", false);
    const latest = f.history.list("account-1").revisions[0]!;
    const target = f.history.rollbackTarget("account-1", latest.id);
    f.db
      .prepare(
        "UPDATE provider_connections SET updated_at='external-change' WHERE id='account-1'",
      )
      .run();
    const result = await f.activation.set(
      "account-1",
      target.enabled,
      target.expectedCurrentRevision,
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toMatch(/gewijzigd sinds/);
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("keeps inference blocked when a successful API response cannot be verified", async () => {
    const f = fixture();
    f.setPersisted(false);
    const result = await f.activation.set("account-1", false);
    expect(result).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
  });

  it("allows a recovery toggle while the free route is unready, then verifies before release", async () => {
    const f = fixture(false);
    const result = await f.activation.set("account-1", true);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      enabled: true,
      routeReady: true,
    });
    expect(f.request).toHaveBeenCalledWith("/api/providers/account-1", {
      method: "PATCH",
      body: { isActive: true },
    });
    expect(() => f.routing.assertFree()).not.toThrow();
  });
});
