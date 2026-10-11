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
import { OmniRouteAccountCreate } from "../../src/settings/omniroute-account-create.service.js";

const secret = "super-secret-provider-key-value";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-account-create-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,is_active INTEGER,api_key TEXT)",
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
  let duplicate = false;
  const request = vi.fn(
    async (
      endpoint: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      if (endpoint.startsWith("/api/providers?provider="))
        return {
          total: duplicate ? 1 : 0,
          connections: duplicate
            ? [{ provider: "mistral", name: "Personal" }]
            : [],
        };
      if (endpoint === "/api/providers" && options?.method === "POST") {
        expect(options.body).toEqual({
          provider: "mistral",
          name: "Personal",
          apiKey: secret,
        });
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persist)
          db.prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)").run(
            "account-1",
            "mistral",
            "Personal",
            0,
            secret,
          );
        return {
          connection: {
            id: "account-1",
            provider: "mistral",
            name: "Personal",
            apiKey: secret,
          },
        };
      }
      if (endpoint === "/api/providers/account-1")
        return {
          connection: {
            id: "account-1",
            provider: "mistral",
            name: "Personal",
            isActive: false,
            apiKey: secret,
          },
        };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteAccountCreate(
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
    setDuplicate: (value: boolean) => (duplicate = value),
  };
}

describe("OmniRoute provider account creation", () => {
  it("requires explicit acknowledgement and rejects invalid or duplicate account details", async () => {
    const f = fixture();
    await expect(
      f.service.prepare("mistral", "Personal", secret, false),
    ).rejects.toThrow("bevestig");
    await expect(
      f.service.prepare("mistral/../custom", "Personal", secret, true),
    ).rejects.toThrow("provider-ID");
    f.setDuplicate(true);
    await expect(
      f.service.prepare("mistral", "Personal", secret, true),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("al een account"),
    });
    expect(f.request).not.toHaveBeenCalledWith(
      "/api/providers",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the key out of confirmation and audit, then verifies API and SQLite", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(
      "mistral",
      "Personal",
      secret,
      true,
    );
    expect(prepared).toMatchObject({
      ok: true,
      provider: "mistral",
      name: "Personal",
      action: { risk: "DANGEROUS" },
    });
    expect(JSON.stringify(prepared)).not.toContain(secret);
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(prepared.action?.args)).not.toContain(
      "secretFingerprint",
    );
    expect(f.request).not.toHaveBeenCalledWith(
      "/api/providers",
      expect.objectContaining({ method: "POST" }),
    );

    const action = prepared.action!;
    const result = await f.service.confirm(
      action.sessionId,
      action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      id: "account-1",
      active: false,
      routeReady: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(secret);
    expect(
      f.db
        .prepare("SELECT api_key FROM provider_connections WHERE id=?")
        .get("account-1"),
    ).toEqual({ api_key: secret });
    expect(f.request).toHaveBeenCalledWith("/api/providers", {
      method: "POST",
      body: { provider: "mistral", name: "Personal", apiKey: secret },
    });
  });

  it("keeps routing blocked if upstream creation cannot be verified in SQLite", async () => {
    const f = fixture();
    f.setPersist(false);
    const prepared = await f.service.prepare(
      "mistral",
      "Personal",
      secret,
      true,
    );
    const action = prepared.action!;
    const result = await f.service.confirm(
      action.sessionId,
      action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.routing.status().ready).toBe(false);
  });
});
