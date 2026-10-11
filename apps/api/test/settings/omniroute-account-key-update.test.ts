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
import { OmniRouteAccountKeyUpdate } from "../../src/settings/omniroute-account-key-update.service.js";

const oldKey = "existing-provider-api-key";
const newKey = "replacement-provider-api-key";
const ready: RoutingStatus = {
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
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-account-key-update-"),
  );
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,is_active INTEGER,api_key TEXT)",
  );
  db.prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)").run(
    "account-1",
    "mistral",
    "Personal",
    1,
    oldKey,
  );
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: file,
    dataFile: (name: string) => path.join(dir, name),
  };
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "audit",
    timestamp: "now",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => Date.now();
  const routing = new RoutingService(config as NovaConfig);
  vi.spyOn(routing, "verifyForManagement").mockReturnValue(ready);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  let persist = true;
  let authType: unknown = "apikey";
  const request = vi.fn(
    async (
      endpoint: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      if (
        endpoint === "/api/providers/account-1" &&
        options?.method === "PUT"
      ) {
        expect(options.body).toEqual({ apiKey: newKey });
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persist)
          db.prepare(
            "UPDATE provider_connections SET api_key=? WHERE id=?",
          ).run(newKey, "account-1");
        return { connection: { id: "account-1" } };
      }
      if (endpoint === "/api/providers/account-1")
        return {
          connection: {
            id: "account-1",
            provider: "mistral",
            name: "Personal",
            authType,
            isActive: true,
            apiKey: "m...d",
          },
        };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteAccountKeyUpdate(
    config as NovaConfig,
    management,
    confirmations,
    audit,
    barrier,
    routing,
  );
  return {
    service,
    db,
    record,
    request,
    routing,
    setPersist: (value: boolean) => (persist = value),
    setAuthType: (value: unknown) => (authType = value),
  };
}

describe("OmniRoute API key rotation", () => {
  it("requires an eligible API-key account and explicit global-effect acknowledgement", async () => {
    const { service, setAuthType, request } = fixture();
    await expect(service.prepare("account-1", newKey, false)).rejects.toThrow(
      "bevestig de clientbrede wijziging",
    );
    setAuthType("oauth");
    expect(await service.prepare("account-1", newKey, true)).toMatchObject({
      ok: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("replaces the key after confirmation and excludes both keys from audit", async () => {
    const { service, db, record, request, routing } = fixture();
    const prepared = await service.prepare("account-1", newKey, true);
    expect(prepared).toMatchObject({
      ok: true,
      provider: "mistral",
      name: "Personal",
    });
    const action = prepared.action!;
    expect(JSON.stringify(action.args)).not.toContain(oldKey);
    expect(JSON.stringify(action.args)).not.toContain(newKey);
    const result = await service.confirm(
      action.sessionId,
      action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(
      db
        .prepare("SELECT api_key FROM provider_connections WHERE id=?")
        .get("account-1"),
    ).toEqual({ api_key: newKey });
    expect(
      request.mock.calls.some(
        ([, options]) =>
          options?.method === "PUT" &&
          JSON.stringify(options.body).includes(newKey),
      ),
    ).toBe(true);
    expect(JSON.stringify(record.mock.calls)).not.toContain(oldKey);
    expect(JSON.stringify(record.mock.calls)).not.toContain(newKey);
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/[a-f0-9]{64}/);
    expect(routing.status().ready).toBe(true);
  });

  it("keeps routing blocked when OmniRoute cannot verify persistence", async () => {
    const { service, setPersist, routing } = fixture();
    setPersist(false);
    const prepared = await service.prepare("account-1", newKey, true);
    const action = prepared.action!;
    expect(
      await service.confirm(action.sessionId, action.confirmationId, true),
    ).toMatchObject({ ok: false, verified: null, routeReady: false });
    expect(routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
  });
});
