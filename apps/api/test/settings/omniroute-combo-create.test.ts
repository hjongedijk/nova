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
import { OmniRouteComboCreate } from "../../src/settings/omniroute-combo-create.service.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-combo-create-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE combos(id TEXT PRIMARY KEY,name TEXT,data TEXT,sort_order INTEGER)",
  );
  db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
    "old",
    "existing",
    JSON.stringify({ models: [], isActive: true }),
    0,
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
  const routing = new RoutingService(config as NovaConfig);
  vi.spyOn(routing, "verifyForManagement").mockReturnValue(ready);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  let persist = true;
  const request = vi.fn(
    async (endpoint: string, options?: { method?: string; body?: unknown }) => {
      if (endpoint === "/api/providers?limit=200&offset=0")
        return { connections: [{ provider: "provider-1", isActive: true }] };
      if (endpoint === "/api/free-models")
        return {
          models: [
            {
              provider: "provider-1",
              modelId: "free-model",
              freeType: "recurring",
            },
            {
              provider: "provider-1",
              modelId: "inactive-model",
              freeType: "free",
            },
          ],
        };
      if (endpoint === "/api/combos?limit=200&offset=0")
        return { combos: [{ id: "old", name: "existing" }] };
      if (endpoint === "/api/combos" && options?.method === "POST") {
        expect(options.body).toEqual({
          name: "My route",
          models: ["provider-1/free-model"],
        });
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persist)
          db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
            "created",
            "My route",
            JSON.stringify({
              models: ["provider-1/free-model"],
              isActive: true,
            }),
            1,
          );
        return {
          id: "created",
          name: "My route",
          isActive: true,
          models: ["provider-1/free-model"],
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteComboCreate(
    config as NovaConfig,
    management,
    audit,
    barrier,
    routing,
  );
  return {
    service,
    db,
    request,
    record,
    routing,
    setPersist: (value: boolean) => (persist = value),
  };
}

describe("OmniRoute combo creation (single step)", () => {
  it("does not expose diagnostics that contain a duplicate-name phrase", async () => {
    const f = fixture();
    const diagnostic = "al een combo /private/omniroute token=marker";
    f.request.mockRejectedValueOnce(new Error(diagnostic));
    const result = await f.service.create("My route", [
      "provider-1/free-model",
    ]);
    expect(result).toEqual({
      ok: false,
      error:
        "Combo aanmaken is niet beschikbaar. Controleer de OmniRoute-koppeling.",
    });
    expect(JSON.stringify(result)).not.toContain(diagnostic);
  });

  it("rejects invalid input and models outside the active free catalog without writing", async () => {
    const f = fixture();
    await expect(
      f.service.create("", ["provider-1/free-model"]),
    ).rejects.toThrow("naam");
    await expect(f.service.create("My route", [])).rejects.toThrow("naam");
    await expect(
      f.service.create("Bad route", ["provider-1/missing-model"]),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      f.service.create("existing", ["provider-1/free-model"]),
    ).resolves.toMatchObject({
      ok: false,
      error: "Er bestaat al een combo met deze naam.",
    });
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
  });

  it("creates only name and models in one call, then verifies the combo in SQLite under the route barrier", async () => {
    const f = fixture();
    const result = await f.service.create("My route", [
      "provider-1/free-model",
    ]);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      id: "created",
      routeReady: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|system_message/);
    expect(
      f.db.prepare("SELECT id,name FROM combos WHERE id='created'").get(),
    ).toEqual({ id: "created", name: "My route" });
    expect(f.request).toHaveBeenCalledWith("/api/combos", {
      method: "POST",
      body: { name: "My route", models: ["provider-1/free-model"] },
    });
    const phases = f.record.mock.calls.map(([record]) => record.phase);
    expect(phases).toContain("before_execute");
    expect(phases).toContain("after_execute");
  });

  it("retains the blocked route if the create response is not persisted", async () => {
    const f = fixture();
    f.setPersist(false);
    const result = await f.service.create("My route", [
      "provider-1/free-model",
    ]);
    expect(result).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
  });
});
