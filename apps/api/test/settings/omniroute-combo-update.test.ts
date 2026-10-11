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
import { OmniRouteComboUpdate } from "../../src/settings/omniroute-combo-update.service.js";
import { OmniRouteComboUpdateHistory } from "../../src/settings/omniroute-combo-update-history.service.js";

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
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => 1000;
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
    confirmations,
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

describe("OmniRoute combo update", () => {
  it("protects generated combos and requires global-impact acknowledgement", async () => {
    const f = fixture();
    expect(
      await f.service.prepare(
        "combo-auto",
        "Updated route",
        ["provider/model-b"],
        true,
      ),
    ).toMatchObject({ ok: false });
    await expect(
      f.service.prepare(
        "combo-1",
        "Updated route",
        ["provider/model-b"],
        false,
      ),
    ).rejects.toThrow("bevestig");
    await expect(
      f.service.prepare("combo-1", "Updated route", ["provider/missing"], true),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("beschikbaar"),
    });
    expect(f.request).not.toHaveBeenCalledWith(
      "/api/combos/combo-1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("requires fresh DANGEROUS confirmation and preserves all non-editable config", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(
      "combo-1",
      "Updated route",
      ["provider/model-b"],
      true,
    );
    expect(prepared).toMatchObject({
      ok: true,
      models: ["provider/model-b"],
      action: { risk: "DANGEROUS" },
    });
    const action = prepared.action!;
    expect(f.request).not.toHaveBeenCalledWith(
      "/api/combos/combo-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const result = await f.service.confirm(
      "combo-1",
      action.sessionId,
      action.confirmationId,
      true,
    );
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
    expect(f.record.mock.calls.map(([entry]) => entry.confirmation)).toContain(
      "confirmed_admin_ui",
    );
  });

  it("keeps inference blocked when the update cannot be verified", async () => {
    const f = fixture();
    f.setPersist(false);
    const prepared = await f.service.prepare(
      "combo-1",
      "Updated route",
      ["provider/model-b"],
      true,
    );
    const action = prepared.action!;
    expect(
      await f.service.confirm(
        "combo-1",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false, verified: null, routeReady: false });
    expect(f.routing.status().ready).toBe(false);
  });

  it("records secret-free combo revisions and restores only the newest one", async () => {
    const f = fixture();
    const first = await f.service.prepare(
      "combo-1",
      "Updated route",
      ["provider/model-b"],
      true,
    );
    const action = first.action!;
    expect(
      await f.service.confirm(
        "combo-1",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: true, verified: true });
    expect(f.request).toHaveBeenCalledWith("/api/combos/combo-1", {
      method: "PUT",
      body: { name: "Updated route", models: ["provider/model-b"] },
    });
    const historyFile = path.join(f.dir, "omniroute-combo-update-history.json");
    const stat = fs.statSync(historyFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const storedHistory = fs.readFileSync(historyFile, "utf8");
    expect(storedHistory).not.toContain("keep this prompt");
    const revisions = f.history.list("combo-1").revisions;
    expect(revisions).toHaveLength(1);
    const rollback = await f.service.prepareRollback(
      "combo-1",
      revisions[0]!.id,
    );
    expect(rollback).toMatchObject({
      ok: true,
      models: ["provider/model-a"],
      action: { risk: "DANGEROUS" },
    });
    const rollbackAction = rollback.action!;
    expect(
      await f.service.confirm(
        "combo-1",
        rollbackAction.sessionId,
        rollbackAction.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: true, verified: true });
    const saved = f.db
      .prepare("SELECT name,data FROM combos WHERE id=?")
      .get("combo-1") as { name: string; data: string };
    expect(saved.name).toBe("Custom route");
    expect(JSON.parse(saved.data)).toMatchObject({
      models: ["provider/model-a"],
      system_message: "keep this prompt",
    });
    const revisionsAfterRollback = f.history.list("combo-1").revisions;
    expect(revisionsAfterRollback).toHaveLength(2);
    await expect(
      f.service.prepareRollback("combo-1", revisions[0]!.id),
    ).rejects.toThrow("nieuwste combo-wijziging");
  });
});
