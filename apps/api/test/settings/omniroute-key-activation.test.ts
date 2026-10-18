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
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteKeyActivation } from "../../src/settings/omniroute-key-activation.service.js";
import { OmniRouteActivationHistory } from "../../src/settings/omniroute-activation-history.service.js";
import { dbStat, historyText } from "../helpers/nova-db.js";

const cleanups: (() => void)[] = [];
const ready: RoutingStatus = {
  ready: true,
  policyVerified: true,
  freeOnly: true,
  status: "VERIFIED_FREE_ROUTE",
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-key-activation-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE api_keys(id TEXT PRIMARY KEY,key TEXT,is_active INTEGER,revoked_at TEXT,model_access_mode TEXT,allowed_models TEXT,allowed_connections TEXT,allowed_combos TEXT,allow_auto_combos INTEGER)",
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?)").run(
    "nova",
    "secret-nova",
    1,
    null,
    "all",
    null,
    null,
    null,
    1,
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?)").run(
    "client",
    "secret-client",
    1,
    null,
    "all",
    null,
    null,
    null,
    1,
  );
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: file,
    omniKey: "secret-nova",
    dataFile: (name: string) => path.join(dir, name),
  };
  const historyFile = path.join(
    dir,
    "omniroute-account-activation-history.json",
  );
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
      if (options?.method === "PATCH") {
        expect(endpoint).toBe("/api/keys/client");
        const enabled = (options.body as { isActive: boolean }).isActive;
        if (persist)
          db.prepare("UPDATE api_keys SET is_active=? WHERE id='client'").run(
            Number(enabled),
          );
        return {};
      }
      return {
        keys: [
          { id: "nova", name: "NOVA", isActive: true, key: "secret-nova" },
          {
            id: "client",
            name: "Personal client",
            isActive:
              (
                db
                  .prepare("SELECT is_active FROM api_keys WHERE id='client'")
                  .get() as { is_active: number }
              ).is_active === 1,
            key: "secret-client",
          },
        ],
      };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const history = new OmniRouteActivationHistory(config as NovaConfig);
  const activation = new OmniRouteKeyActivation(
    config as NovaConfig,
    management,
    audit,
    barrier,
    routing,
    history,
  );
  return {
    activation,
    db,
    record,
    request,
    history,
    historyFile,
    setPersist: (value: boolean) => (persist = value),
  };
}

describe("OmniRoute API-key activation (single step)", () => {
  it("protects NOVA's key and rejects an invalid status", async () => {
    const f = fixture();
    expect(await f.activation.apply("nova", false)).toMatchObject({
      ok: false,
    });
    await expect(f.activation.apply("client", "off")).rejects.toThrow("status");
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
  });
  it("updates only isActive in one call and verifies local persistence", async () => {
    const f = fixture();
    const result = await f.activation.apply("client", false);
    expect(result).toMatchObject({ ok: true, verified: true, enabled: false });
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(
      f.db.prepare("SELECT is_active FROM api_keys WHERE id='client'").get(),
    ).toEqual({ is_active: 0 });
    const phases = f.record.mock.calls.map(([item]) => item.phase);
    expect(phases).toContain("before_execute");
    expect(phases).toContain("after_execute");
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("secret-");
    expect(f.history.list("client", "key").revisions).toMatchObject([
      { beforeEnabled: true, afterEnabled: false },
    ]);
    expect(dbStat(f.historyFile).mode & 0o777).toBe(0o600);
    expect(historyText(f.historyFile)).not.toContain("secret-");
  });
  it("keeps the operation unverified if OmniRoute does not persist the change", async () => {
    const f = fixture();
    f.setPersist(false);
    expect(await f.activation.apply("client", false)).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
  });
  it("restores only the newest key status in one call", async () => {
    const f = fixture();
    expect(await f.activation.apply("client", false)).toMatchObject({
      ok: true,
      enabled: false,
    });
    const revision = f.history.list("client", "key").revisions[0]!;
    const target = f.history.rollbackTarget("client", revision.id, "key");
    expect(
      await f.activation.apply(
        "client",
        target.enabled,
        target.expectedCurrentRevision,
      ),
    ).toMatchObject({ ok: true, enabled: true, verified: true });
    expect(
      f.db.prepare("SELECT is_active FROM api_keys WHERE id='client'").get(),
    ).toEqual({ is_active: 1 });
    const revisions = f.history.list("client", "key").revisions;
    expect(revisions).toHaveLength(2);
    expect(() =>
      f.history.rollbackTarget("client", revisions[1]!.id, "key"),
    ).toThrow("nieuwste wijziging");
  });
  it("rejects rollback when key rights changed after recorded status", async () => {
    const f = fixture();
    await f.activation.apply("client", false);
    const revision = f.history.list("client", "key").revisions[0]!;
    const target = f.history.rollbackTarget("client", revision.id, "key");
    f.db
      .prepare(
        `UPDATE api_keys SET allowed_models='["changed"]' WHERE id='client'`,
      )
      .run();
    expect(
      await f.activation.apply(
        "client",
        target.enabled,
        target.expectedCurrentRevision,
      ),
    ).toMatchObject({ ok: false });
  });
});
