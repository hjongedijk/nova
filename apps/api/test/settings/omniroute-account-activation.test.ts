import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
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
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => 1000;
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
    confirmations,
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

describe("OmniRoute provider account activation", () => {
  it("requires explicit global-impact acknowledgement and never exposes credentials", async () => {
    const f = fixture();
    await expect(
      f.activation.prepare("account-1", false, false),
    ).rejects.toThrow("bevestig");
    expect(f.request).not.toHaveBeenCalled();
    const prepared = await f.activation.prepare("account-1", false, true);
    expect(prepared).toMatchObject({
      ok: true,
      name: "Friendly account",
      currentEnabled: true,
      enabled: false,
    });
    expect(JSON.stringify(prepared)).not.toContain("must-not-leak");
    expect(JSON.stringify(prepared)).not.toContain("apiKey");
    expect(prepared.action).toMatchObject({
      tool: "omniroute_account_activation",
      risk: "DANGEROUS",
      allowAlways: false,
    });
  });

  it("writes only isActive under the routing barrier and verifies local and gateway state", async () => {
    const f = fixture();
    const prepared = await f.activation.prepare("account-1", false, true);
    const action = prepared.action!;
    const result = await f.activation.confirm(
      "account-1",
      action.sessionId,
      action.confirmationId,
      true,
    );
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
    expect(f.record.mock.calls.map(([record]) => record.phase)).toContain(
      "before_execute",
    );
    expect(f.record.mock.calls.map(([record]) => record.phase)).toContain(
      "after_execute",
    );
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
      fs.statSync(path.join(f.dir, "omniroute-account-activation-history.json"))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("restores only the latest account status after fresh confirmation and revision check", async () => {
    const f = fixture();
    const first = await f.activation.prepare("account-1", false, true);
    const firstResult = await f.activation.confirm(
      "account-1",
      first.action!.sessionId,
      first.action!.confirmationId,
      true,
    );
    expect(firstResult.ok).toBe(true);
    const latest = f.history.list("account-1").revisions[0]!;
    const target = f.history.rollbackTarget("account-1", latest.id);
    const rollback = await f.activation.prepare(
      "account-1",
      target.enabled,
      true,
      target.expectedCurrentRevision,
    );
    expect(rollback).toMatchObject({ ok: true, enabled: true });
    const result = await f.activation.confirm(
      "account-1",
      rollback.action!.sessionId,
      rollback.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({ ok: true, verified: true, enabled: true });
    expect(f.history.list("account-1").revisions).toHaveLength(2);
    expect(() => f.history.rollbackTarget("account-1", latest.id)).toThrow(
      "nieuwste wijziging",
    );
  });

  it("refuses rollback preparation after an external upstream account change", async () => {
    const f = fixture();
    const change = await f.activation.prepare("account-1", false, true);
    await f.activation.confirm(
      "account-1",
      change.action!.sessionId,
      change.action!.confirmationId,
      true,
    );
    const latest = f.history.list("account-1").revisions[0]!;
    const target = f.history.rollbackTarget("account-1", latest.id);
    f.db
      .prepare(
        "UPDATE provider_connections SET updated_at='external-change' WHERE id='account-1'",
      )
      .run();
    const prepared = await f.activation.prepare(
      "account-1",
      target.enabled,
      true,
      target.expectedCurrentRevision,
    );
    expect(prepared).toMatchObject({ ok: false });
    expect(JSON.stringify(prepared)).toMatch(/gewijzigd sinds/);
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("keeps inference blocked when a successful API response cannot be verified", async () => {
    const f = fixture();
    f.setPersisted(false);
    const prepared = await f.activation.prepare("account-1", false, true);
    const action = prepared.action!;
    const result = await f.activation.confirm(
      "account-1",
      action.sessionId,
      action.confirmationId,
      true,
    );
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

  it("allows a confirmed recovery toggle while the free route is unready, then verifies before release", async () => {
    const f = fixture(false);
    const prepared = await f.activation.prepare("account-1", true, true);
    expect(prepared).toMatchObject({
      ok: true,
      currentEnabled: false,
      enabled: true,
    });
    const action = prepared.action!;
    const result = await f.activation.confirm(
      "account-1",
      action.sessionId,
      action.confirmationId,
      true,
    );
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

  it("rejects stale pending confirmation and cancels cleanly", async () => {
    const f = fixture();
    const pending = await f.activation.prepare("account-1", false, true);
    f.db
      .prepare(
        "UPDATE provider_connections SET updated_at='external-change' WHERE id='account-1'",
      )
      .run();
    const stale = await f.activation.confirm(
      "account-1",
      pending.action!.sessionId,
      pending.action!.confirmationId,
      true,
    );
    expect(stale).toMatchObject({
      ok: false,
      error: expect.stringContaining("ondertussen gewijzigd"),
    });
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);

    const declined = await f.activation.prepare("account-1", false, true);
    expect(
      await f.activation.confirm(
        "account-1",
        declined.action!.sessionId,
        declined.action!.confirmationId,
        false,
      ),
    ).toEqual({ ok: true });
  });
});
