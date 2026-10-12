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
import {
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteKeyModelAccess } from "../../src/settings/omniroute-key-model-access.service.js";

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
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => 1000;
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
    confirmations,
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

describe("OmniRoute key model access", () => {
  it("restricts non-NOVA keys to selected verified-free models after fresh confirmation", async () => {
    const f = fixture();
    const options = await f.service.options("client");
    expect(options).toMatchObject({
      available: true,
      accessMode: "all",
      verifiedFreeModels: ["free/one", "free/two"],
    });
    expect(JSON.stringify(options)).not.toContain("secret-");
    const prepared = await f.service.prepare(
      "client",
      ["free/one"],
      options.revision,
      true,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    expect(
      f.request.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(0);
    const action = prepared.action;
    expect(JSON.stringify(prepared)).not.toContain("secret-");
    expect(
      await f.service.confirm(
        "client",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
      allowedModels: ["free/one"],
    });
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
      fs.statSync(path.join(f.dir, "omniroute-key-model-access-history.json"))
        .mode & 0o777,
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

  it("rejects NOVA's key, paid or empty model selections, and stale revisions", async () => {
    const f = fixture();
    expect((await f.service.options("nova")).available).toBe(false);
    const options = await f.service.options("client");
    expect(
      await f.service.prepare("client", ["paid/model"], options.revision, true),
    ).toMatchObject({ ok: false });
    expect(
      await f.service.prepare("client", [], options.revision, true),
    ).toMatchObject({ ok: false });
    expect(
      await f.service.prepare("client", ["free/one"], "0".repeat(64), true),
    ).toMatchObject({ ok: false });
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
    const options = await f.service.options("client");
    const prepared = await f.service.prepare(
      "client",
      ["free/one"],
      options.revision,
      true,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    expect(
      await f.service.confirm(
        "client",
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
      historyWarning: expect.stringContaining("auditregel"),
    });
    expect(f.released).toHaveBeenCalledOnce();
  });

  it("restores the latest model-access revision and records a secret-free rollback", async () => {
    const f = fixture();
    const options = await f.service.options("client");
    const prepared = await f.service.prepare(
      "client",
      ["free/one"],
      options.revision,
      true,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const changed = await f.service.confirm(
      "client",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    expect(changed).toMatchObject({ ok: true, verified: true });
    const originalRevision = f.service.history("client").revisions[0]!;
    const rollback = await f.service.prepareRollback(
      "client",
      originalRevision.id,
      true,
    );
    expect(rollback).toMatchObject({ ok: true, warning: expect.any(String) });
    if (!rollback.ok) throw new Error(rollback.error);
    expect(rollback.action.risk).toBe("DANGEROUS");
    const result = await f.service.confirm(
      "client",
      rollback.action.sessionId,
      rollback.action.confirmationId,
      true,
    );
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

  it("rejects a stale model-access rollback after preparation", async () => {
    const f = fixture();
    const options = await f.service.options("client");
    const prepared = await f.service.prepare(
      "client",
      ["free/one"],
      options.revision,
      true,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    await f.service.confirm(
      "client",
      prepared.action.sessionId,
      prepared.action.confirmationId,
      true,
    );
    const revision = f.service.history("client").revisions[0]!;
    const rollback = await f.service.prepareRollback(
      "client",
      revision.id,
      true,
    );
    if (!rollback.ok) throw new Error(rollback.error);
    f.db
      .prepare("UPDATE api_keys SET allowed_models=? WHERE id='client'")
      .run(JSON.stringify(["free/two"]));
    expect(
      await f.service.confirm(
        "client",
        rollback.action.sessionId,
        rollback.action.confirmationId,
        true,
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
    const options = await f.service.options("client");
    const prepared = await f.service.prepare(
      "client",
      ["free/one"],
      options.revision,
      true,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const action = prepared.action;
    expect(
      await f.service.confirm(
        "client",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false, verified: null, routeReady: false });
    expect(f.blocked).toHaveBeenCalledWith("policy_change");
    expect(f.released).not.toHaveBeenCalled();
  });
});
