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
import { OmniRouteComboUpdate } from "../../src/settings/omniroute-combo-update.service.js";
import { OmniRouteComboUpdateHistory } from "../../src/settings/omniroute-combo-update-history.service.js";
import { dbStat, historyText } from "../helpers/nova-db.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-combo-update-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE combos(id TEXT PRIMARY KEY,name TEXT,data TEXT,sort_order INTEGER)",
  );
  const initial = {
    isActive: true,
    models: ["provider/model-a"],
    system_message: "keep this prompt",
  };
  db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
    "combo-1",
    "Custom route",
    JSON.stringify(initial),
    1,
  );
  db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
    "combo-auto",
    "qtSd/automatic",
    JSON.stringify(initial),
    2,
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
    async (
      endpoint: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      if (endpoint === "/api/providers?limit=200&offset=0")
        return { connections: [{ provider: "provider", isActive: true }] };
      if (endpoint === "/api/free-models")
        return {
          models: [
            { provider: "provider", modelId: "model-a", freeType: "Free" },
            { provider: "provider", modelId: "model-b", freeType: "Free" },
          ],
        };
      if (endpoint === "/api/combos?limit=200&offset=0")
        return { combos: [{ id: "combo-1", name: "Custom route" }] };
      const id = endpoint.split("/").at(-1)!;
      if (options?.method === "PUT") {
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persist) {
          const body = options.body!;
          const row = db
            .prepare("SELECT data FROM combos WHERE id=?")
            .get(id) as { data: string };
          db.prepare("UPDATE combos SET name=?,data=? WHERE id=?").run(
            String(body.name),
            JSON.stringify({ ...JSON.parse(row.data), models: body.models }),
            id,
          );
        }
      }
      const row = db
        .prepare("SELECT id,name,data FROM combos WHERE id=?")
        .get(id) as { id: string; name: string; data: string } | undefined;
      if (!row) throw new Error("missing combo");
      const data = JSON.parse(row.data);
      return {
        id,
        name: row.name,
        isActive: data.isActive,
        models: data.models,
      };
      if (endpoint === "/api/combos?limit=200&offset=0")
        return { combos: [{ id: "combo-1", name: "Custom route" }] };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const history = new OmniRouteComboUpdateHistory(config as NovaConfig);
  const service = new OmniRouteComboUpdate(
    config as NovaConfig,
    management,
    audit,
    barrier,
    routing,
    history,
  );
  return {
    service,
    history,
    dir,
    db,
    record,
    request,
    routing,
    setPersist: (value: boolean) => (persist = value),
  };
}

describe("OmniRoute combo update (single step)", () => {
  it("protects generated combos and rejects invalid input or unavailable models", async () => {
    const f = fixture();
    expect(
      await f.service.update("combo-auto", "Updated route", [
        "provider/model-b",
      ]),
    ).toMatchObject({ ok: false });
    await expect(
      f.service.update("combo-1", "", ["provider/model-b"]),
    ).rejects.toThrow("naam");
    await expect(
      f.service.update("combo-1", "Updated route", ["provider/missing"]),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("beschikbaar"),
    });
    expect(f.request).not.toHaveBeenCalledWith(
      "/api/combos/combo-1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("updates in one call and preserves all non-editable config", async () => {
    const f = fixture();
    const result = await f.service.update("combo-1", "Updated route", [
      "provider/model-b",
    ]);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
    });
    const stored = f.db
      .prepare("SELECT name,data FROM combos WHERE id=?")
      .get("combo-1") as { name: string; data: string };
    expect(stored.name).toBe("Updated route");
    expect(JSON.parse(stored.data)).toMatchObject({
      isActive: true,
      models: ["provider/model-b"],
      system_message: "keep this prompt",
    });
    expect(f.request).toHaveBeenCalledWith("/api/combos/combo-1", {
      method: "PUT",
      body: { name: "Updated route", models: ["provider/model-b"] },
    });
    const confirmations = f.record.mock.calls.map(
      ([entry]) => entry.confirmation,
    );
    expect(confirmations).not.toContain("pending_admin_ui");
    expect(confirmations).not.toContain("confirmed_admin_ui");
  });

  it("keeps inference blocked when the update cannot be verified", async () => {
    const f = fixture();
    f.setPersist(false);
    expect(
      await f.service.update("combo-1", "Updated route", ["provider/model-b"]),
    ).toMatchObject({ ok: false, verified: null, routeReady: false });
    expect(f.routing.status().ready).toBe(false);
  });

  it("records secret-free combo revisions and restores only the newest one in one call", async () => {
    const f = fixture();
    expect(
      await f.service.update("combo-1", "Updated route", ["provider/model-b"]),
    ).toMatchObject({ ok: true, verified: true });
    const historyFile = path.join(f.dir, "omniroute-combo-update-history.json");
    const stat = dbStat(historyFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(historyText(historyFile)).not.toContain("keep this prompt");
    const revisions = f.history.list("combo-1").revisions;
    expect(revisions).toHaveLength(1);
    expect(await f.service.rollback("combo-1", revisions[0]!.id)).toMatchObject(
      { ok: true, verified: true },
    );
    const saved = f.db
      .prepare("SELECT name,data FROM combos WHERE id=?")
      .get("combo-1") as { name: string; data: string };
    expect(saved.name).toBe("Custom route");
    expect(JSON.parse(saved.data)).toMatchObject({
      models: ["provider/model-a"],
      system_message: "keep this prompt",
    });
    expect(f.history.list("combo-1").revisions).toHaveLength(2);
    await expect(
      f.service.rollback("combo-1", revisions[0]!.id),
    ).rejects.toThrow("nieuwste combo-wijziging");
  });
});
