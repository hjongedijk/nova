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
import { OmniRouteComboRemoval } from "../../src/settings/omniroute-combo-removal.service.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-combo-removal-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE combos(id TEXT PRIMARY KEY,name TEXT,data TEXT,sort_order INTEGER)",
  );
  const data = JSON.stringify({
    isActive: true,
    models: ["provider/model"],
    system_message: "private prompt",
  });
  db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
    "combo-1",
    "Custom route",
    data,
    1,
  );
  db.prepare("INSERT INTO combos VALUES(?,?,?,?)").run(
    "combo-auto",
    "qtSd/automatic",
    data,
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
    async (endpoint: string, options?: { method?: string }) => {
      const id = endpoint.split("/").at(-1)!;
      if (options?.method === "DELETE") {
        expect(endpoint).toBe("/api/combos/combo-1");
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persist) db.prepare("DELETE FROM combos WHERE id=?").run(id);
        return { success: true };
      }
      const row = db
        .prepare("SELECT id,name,data FROM combos WHERE id=?")
        .get(id) as { id: string; name: string; data: string } | undefined;
      if (!row) throw new Error("missing combo");
      return { id, name: row.name, isActive: JSON.parse(row.data).isActive };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteComboRemoval(
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
  };
}

describe("OmniRoute combo removal", () => {
  it("protects generated combos and requires the global-effect acknowledgement", async () => {
    const f = fixture();
    expect(await f.service.prepare("combo-auto", true)).toMatchObject({
      ok: false,
    });
    await expect(f.service.prepare("combo-1", false)).rejects.toThrow(
      "Bevestig",
    );
    const prepared = await f.service.prepare("combo-1", true);
    expect(prepared).toMatchObject({ ok: true, name: "Custom route" });
    expect(JSON.stringify(prepared)).not.toContain("private prompt");
    expect(prepared.action).toMatchObject({
      tool: "omniroute_combo_remove",
      risk: "DANGEROUS",
      allowAlways: false,
    });
  });
  it("deletes only after confirmation and verifies the SQLite row is absent", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("combo-1", true);
    if (!prepared.ok || !prepared.action) throw new Error(prepared.error);
    const result = await f.service.confirm(
      "combo-1",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(
      f.db.prepare("SELECT id FROM combos WHERE id='combo-1'").get(),
    ).toBeUndefined();
    expect(f.request).toHaveBeenCalledWith("/api/combos/combo-1", {
      method: "DELETE",
    });
    expect(f.record.mock.calls.map(([entry]) => entry.phase)).toContain(
      "before_execute",
    );
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("private prompt");
  });
  it("retains the routing stop when SQLite cannot verify deletion", async () => {
    const f = fixture();
    f.setPersist(false);
    const prepared = await f.service.prepare("combo-1", true);
    if (!prepared.ok || !prepared.action) throw new Error(prepared.error);
    expect(
      await f.service.confirm(
        "combo-1",
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false, verified: null, routeReady: false });
    expect(
      f.db.prepare("SELECT id FROM combos WHERE id='combo-1'").get(),
    ).toEqual({ id: "combo-1" });
  });
});
