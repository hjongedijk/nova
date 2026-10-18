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
import {
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteKeyModelAccess } from "../../src/settings/omniroute-key-model-access.service.js";
import { dbStat } from "../helpers/nova-db.js";

const cleanups: (() => void)[] = [];
const ready: RoutingStatus = {
  ready: true,
  policyVerified: true,
  freeOnly: true,
  status: "VERIFIED_FREE_ROUTE",
  enabledModels: ["free/one", "free/two"],
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-key-model-access-"));
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
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "audit",
    timestamp: "now",
  }));
  const audit = { record } as unknown as AuditService;
  const routing = new RoutingService(config as NovaConfig);
  vi.spyOn(routing, "verifyForManagement").mockReturnValue(ready);
  const blocked = vi.fn();
  const released = vi.fn(() => ready);
  const barrier = {
    run: (
      callback: (operation: {
        block: typeof blocked;
        releaseAfterVerification: typeof released;
      }) => Promise<unknown>,
    ) => callback({ block: blocked, releaseAfterVerification: released }),
  };
  let persist = true;
  let remoteModelsOverride: string[] | null | undefined;
  const request = vi.fn(
    async (
      _endpoint: string,
      options?: { method?: string; body?: unknown },
    ) => {
      if (options?.method === "PATCH") {
        const body = options.body as {
          modelAccessMode: string;
          allowedModels: string[] | null;
        };
        if (persist)
          db.prepare(
            "UPDATE api_keys SET model_access_mode=?,allowed_models=? WHERE id='client'",
          ).run(
            body.modelAccessMode,
            body.allowedModels === null
              ? null
              : JSON.stringify(body.allowedModels),
          );
        return {};
      }
      const rows = db
        .prepare(
          "SELECT id,is_active,model_access_mode,allowed_models FROM api_keys",
        )
        .all() as {
        id: string;
        is_active: number;
        model_access_mode: string;
        allowed_models: string | null;
      }[];
      return {
        keys: rows.map((row) => ({
          id: row.id,
          name: row.id === "nova" ? "NOVA" : "Personal client",
          isActive: row.is_active === 1,
          modelAccessMode: row.model_access_mode,
          allowedModels:
            row.id === "client" && remoteModelsOverride !== undefined
              ? remoteModelsOverride
              : row.allowed_models
                ? (JSON.parse(row.allowed_models) as string[])
                : null,
          key: `secret-${row.id}`,
        })),
      };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteKeyModelAccess(
    config as NovaConfig,
    management,
    audit,
    barrier as never,
    routing,
  );
  return {
    dir,
    service,
    db,
    request,
    record,
    blocked,
    released,
    setPersist: (value: boolean) => (persist = value),
    setRemoteModels: (models: string[] | null) => {
      remoteModelsOverride = models;
    },
  };
}

describe("OmniRoute key model access (single step)", () => {
  it("restricts non-NOVA keys to selected verified-free models in one call", async () => {
    const f = fixture();
    const options = await f.service.options("client");
    expect(options).toMatchObject({
      available: true,
      accessMode: "all",
      verifiedFreeModels: ["free/one", "free/two"],
    });
    expect(JSON.stringify(options)).not.toContain("secret-");
    const result = await f.service.apply("client", ["free/one"]);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
      allowedModels: ["free/one"],
    });
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(
      f.db
        .prepare(
          "SELECT model_access_mode,allowed_models FROM api_keys WHERE id='client'",
        )
        .get(),
    ).toEqual({
      model_access_mode: "restricted",
      allowed_models: '["free/one"]',
    });
    expect(f.service.history("client").revisions).toMatchObject([
      {
        keyId: "client",
        name: "Personal client",
        beforeMode: "all",
        afterMode: "restricted",
        afterModels: ["free/one"],
      },
    ]);
    expect(
      dbStat(path.join(f.dir, "omniroute-key-model-access-history.json")).mode &
        0o777,
    ).toBe(0o600);
    expect(
      f.request.mock.calls.find(([, opts]) => opts?.method === "PATCH")?.[1]
        ?.body,
    ).toEqual({
      modelAccessMode: "restricted",
      allowedModels: ["free/one"],
    });
    expect(f.blocked).toHaveBeenCalledWith("policy_change");
    expect(f.released).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("secret-");
  });

  it("rejects NOVA's key and paid, empty or malformed model selections", async () => {
    const f = fixture();
    expect((await f.service.options("nova")).available).toBe(false);
    expect(await f.service.apply("nova", ["free/one"])).toMatchObject({
      ok: false,
    });
    expect(await f.service.apply("client", ["paid/model"])).toMatchObject({
      ok: false,
    });
    expect(await f.service.apply("client", [])).toMatchObject({ ok: false });
    expect(await f.service.apply("client", "free/one")).toMatchObject({
      ok: false,
    });
    expect(
      f.request.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("rejects model rights that disagree between the API and SQLite", async () => {
    const f = fixture();
    f.db
      .prepare(
        "UPDATE api_keys SET model_access_mode='restricted',allowed_models=? WHERE id='client'",
      )
      .run(JSON.stringify(["free/one"]));
    f.setRemoteModels(null);
    expect(await f.service.options("client")).toMatchObject({
      available: false,
    });
    expect(
      f.request.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("returns verified success when only the final audit append fails", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "verified") throw new Error("audit unavailable");
      return { ...entry, id: "audit", timestamp: "now" };
    });
    expect(await f.service.apply("client", ["free/one"])).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
      historyWarning: expect.stringContaining("auditregel"),
    });
    expect(f.released).toHaveBeenCalledOnce();
  });

  it("restores the latest model-access revision in one call and records a secret-free rollback", async () => {
    const f = fixture();
    expect(await f.service.apply("client", ["free/one"])).toMatchObject({
      ok: true,
      verified: true,
    });
    const originalRevision = f.service.history("client").revisions[0]!;
    const result = await f.service.rollback("client", originalRevision.id);
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      allowedModels: [],
    });
    expect(await f.service.options("client")).toMatchObject({
      accessMode: "all",
      allowedModels: ["free/one", "free/two"],
    });
    expect(f.service.history("client").revisions[0]).toMatchObject({
      beforeMode: "restricted",
      afterMode: "all",
      revertedFrom: originalRevision.id,
    });
    expect(JSON.stringify(f.service.history("client"))).not.toContain(
      "secret-",
    );
  });

  it("refuses a rollback of a revision that is no longer the newest or current", async () => {
    const f = fixture();
    await f.service.apply("client", ["free/one"]);
    const revision = f.service.history("client").revisions[0]!;
    f.db
      .prepare("UPDATE api_keys SET allowed_models=? WHERE id='client'")
      .run(JSON.stringify(["free/two"]));
    expect(await f.service.rollback("client", revision.id)).toMatchObject({
      ok: false,
    });
    expect(
      await f.service.rollback(
        "client",
        "00000000-0000-0000-0000-000000000000",
      ),
    ).toMatchObject({ ok: false });
    expect(f.blocked).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("keeps routing blocked when OmniRoute does not persist the restriction", async () => {
    const f = fixture();
    f.setPersist(false);
    expect(await f.service.apply("client", ["free/one"])).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
    expect(f.blocked).toHaveBeenCalledWith("policy_change");
    expect(f.released).not.toHaveBeenCalled();
  });
});
