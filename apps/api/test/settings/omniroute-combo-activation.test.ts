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
import { OmniRouteComboActivation } from "../../src/settings/omniroute-combo-activation.service.js";
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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-combo-activation-"));
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE combos(id TEXT PRIMARY KEY,name TEXT,data TEXT,sort_order INTEGER)",
  );
  const insert = db.prepare("INSERT INTO combos VALUES(?,?,?,?)");
  const initial = {
    isActive: true,
    models: [{ provider: "provider-1", model: "free-model" }],
    system_message: "private combo prompt",
    tool_filter_regex: "private-filter",
  };
  insert.run("combo-1", "free-route", JSON.stringify(initial), 1);
  insert.run("combo-2", "qtSd/private", JSON.stringify(initial), 2);
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    freeOnly: false,
    dataFile: (name: string) => path.join(dir, name),
  };
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => 1_000;
  const routing = new RoutingService(config as NovaConfig);
  const verify = vi
    .spyOn(routing, "verifyForManagement")
    .mockReturnValue(verified);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  const read = (id = "combo-1") =>
    db
      .prepare("SELECT id,name,data,sort_order FROM combos WHERE id=?")
      .get(id) as
      | { id: string; name: string; data: string; sort_order: number }
      | undefined;
  let persisted = true;
  const request = vi.fn(
    async (endpoint: string, options?: { method?: string; body?: unknown }) => {
      const id = endpoint.split("/").at(-1)!;
      const row = read(id);
      if (options?.method === "PATCH") {
        expect(endpoint).toBe("/api/combos/combo-1");
        expect(options.body).toEqual({ isActive: false });
        expect(routing.status()).toMatchObject({
          ready: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
        if (persisted && row) {
          const data = JSON.parse(row.data) as Record<string, unknown>;
          data.isActive = false;
          db.prepare("UPDATE combos SET data=? WHERE id=?").run(
            JSON.stringify(data),
            id,
          );
        }
        return {};
      }
      if (!row) throw new Error("missing combo");
      return { id, name: row.name, isActive: JSON.parse(row.data).isActive };
    },
  );
  const management = {
    get configured() {
      return true;
    },
    request,
  };
  const history = new OmniRouteActivationHistory(config as NovaConfig);
  const service = new OmniRouteComboActivation(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    confirmations,
    audit,
    barrier,
    routing,
    history,
  );
  return {
    service,
    history,
    db,
    read,
    record,
    request,
    routing,
    verify,
    marker: config.dataFile("free-routing-management-block.json"),
    setPersisted: (value: boolean) => (persisted = value),
  };
}

describe("OmniRoute combo activation", () => {
  it("requires global-effect acknowledgement and rejects managed quota combos", async () => {
    const f = fixture();
    await expect(f.service.prepare("combo-1", false, false)).rejects.toThrow(
      "alle OmniRoute-clients",
    );
    expect(await f.service.prepare("combo-2", false, true)).toMatchObject({
      ok: false,
    });
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
  });

  it("requires a verified free route and prepares a secret-free dangerous confirmation", async () => {
    const f = fixture();
    f.verify.mockReturnValue({ ...verified, freeOnly: false });
    expect(await f.service.prepare("combo-1", false, true)).toMatchObject({
      ok: false,
    });
    f.verify.mockReturnValue(verified);
    const prepared = await f.service.prepare("combo-1", false, true);
    expect(prepared).toMatchObject({
      ok: true,
      name: "free-route",
      currentEnabled: true,
      enabled: false,
      action: { risk: "DANGEROUS" },
    });
    expect(JSON.stringify(prepared)).not.toMatch(
      /private combo prompt|private-filter/,
    );
    expect(JSON.stringify(f.record.mock.calls)).not.toMatch(
      /private combo prompt|private-filter/,
    );
  });

  it("patches only isActive under a durable inference stop and verifies SQLite/API", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("combo-1", false, true);
    if (!prepared.action) throw new Error("Missing confirmation");
    const result = await f.service.confirm(
      "combo-1",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      enabled: false,
      routeReady: true,
    });
    expect(JSON.parse(f.read()!.data).isActive).toBe(false);
    const revisions = f.history.list("combo-1", "combo").revisions;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: "combo",
      beforeEnabled: true,
      afterEnabled: false,
    });
    expect(JSON.stringify(revisions)).not.toMatch(
      /private combo prompt|private-filter/,
    );
    const target = f.history.rollbackTarget(
      "combo-1",
      revisions[0]!.id,
      "combo",
    );
    expect(target.enabled).toBe(true);
    expect(target.expectedCurrentRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(
      f.request.mock.calls.map(([path, options]) => [
        path,
        options?.method,
        options?.body,
      ]),
    ).toEqual([
      ["/api/combos/combo-1", undefined, undefined],
      ["/api/combos/combo-1", undefined, undefined],
      ["/api/combos/combo-1", "PATCH", { isActive: false }],
      ["/api/combos/combo-1", undefined, undefined],
    ]);
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(JSON.stringify(f.record.mock.calls)).not.toMatch(
      /private combo prompt|private-filter/,
    );
  });

  it("rejects stale confirmation without writing", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("combo-1", false, true);
    if (!prepared.action) throw new Error("Missing confirmation");
    f.db.prepare("UPDATE combos SET sort_order=9 WHERE id='combo-1'").run();
    const result = await f.service.confirm(
      "combo-1",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("gewijzigd"),
    });
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("keeps inference blocked when the upstream write is not independently verified", async () => {
    const f = fixture();
    f.setPersisted(false);
    const prepared = await f.service.prepare("combo-1", false, true);
    if (!prepared.action) throw new Error("Missing confirmation");
    const result = await f.service.confirm(
      "combo-1",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
    expect(fs.existsSync(f.marker)).toBe(true);
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
  });

  it("keeps inference blocked when policy is no longer verified after the toggle", async () => {
    const f = fixture();
    f.verify
      .mockReturnValueOnce(verified)
      .mockReturnValueOnce({ ...verified, ready: false, freeOnly: false });
    const prepared = await f.service.prepare("combo-1", false, true);
    if (!prepared.action) throw new Error("Missing confirmation");
    const result = await f.service.confirm(
      "combo-1",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      enabled: false,
      routeReady: false,
    });
    expect(fs.existsSync(f.marker)).toBe(true);
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
  });
});
