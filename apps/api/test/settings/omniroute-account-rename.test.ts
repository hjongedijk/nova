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
import { OmniRouteAccountRename } from "../../src/settings/omniroute-account-rename.service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-account-rename-"));
  const file = path.join(dir, "gateway.sqlite");
  const historyFile = path.join(dir, "omniroute-account-rename-history.json");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,is_active INTEGER,updated_at TEXT)",
  );
  db.prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)").run(
    "account-1",
    "mistral",
    "Personal",
    1,
    "rev-1",
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
  let persist = true;
  const request = vi.fn(
    async (
      endpoint: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      if (endpoint === "/api/providers?provider=mistral&limit=200&offset=0") {
        const connections = db
          .prepare(
            "SELECT id,provider,name FROM provider_connections WHERE provider=?",
          )
          .all("mistral") as { id: string; provider: string; name: string }[];
        return { total: connections.length, connections };
      }
      expect(endpoint).toBe("/api/providers/account-1");
      if (options?.method === "PUT") {
        const nextName = options.body?.name;
        if (typeof nextName !== "string") throw new Error("Missing name");
        expect(options.body).toEqual({ name: nextName });
        if (persist)
          db.prepare(
            "UPDATE provider_connections SET name=?,updated_at='rev-2' WHERE id=?",
          ).run(nextName, "account-1");
        return { connection: { id: "account-1" } };
      }
      const row = db
        .prepare(
          "SELECT id,provider,name FROM provider_connections WHERE id='account-1'",
        )
        .get() as { id: string; provider: string; name: string };
      return {
        connection: {
          ...row,
          apiKey: "fixture-key-never-returned",
        },
      };
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const rename = new OmniRouteAccountRename(
    config as NovaConfig,
    management,
    confirmations,
    audit,
  );
  return {
    rename,
    db,
    request,
    record,
    historyFile,
    setPersist: (value: boolean) => (persist = value),
  };
}

describe("OmniRoute provider account rename", () => {
  it("requires explicit all-client acknowledgement and checks complete provider inventory", async () => {
    const f = fixture();
    await expect(
      f.rename.prepare("account-1", "Home Mistral", false),
    ).rejects.toThrow("bevestig");
    expect(f.request).not.toHaveBeenCalled();

    const prepared = await f.rename.prepare("account-1", "Home Mistral", true);
    expect(prepared).toMatchObject({
      ok: true,
      id: "account-1",
      provider: "mistral",
      oldName: "Personal",
      newName: "Home Mistral",
    });
    expect(JSON.stringify(prepared)).not.toMatch(/fixture-key|apiKey/);
    expect(prepared.action).toMatchObject({
      tool: "omniroute_account_rename",
      risk: "DANGEROUS",
      allowAlways: false,
    });
  });

  it("updates only the name and verifies OmniRoute against SQLite", async () => {
    const f = fixture();
    const prepared = await f.rename.prepare("account-1", "Home Mistral", true);
    const action = prepared.action!;
    const result = await f.rename.confirm(
      action.sessionId,
      action.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      id: "account-1",
      name: "Home Mistral",
    });
    expect(f.request).toHaveBeenCalledWith("/api/providers/account-1", {
      method: "PUT",
      body: { name: "Home Mistral" },
    });
    expect(
      f.db
        .prepare("SELECT name FROM provider_connections WHERE id='account-1'")
        .get(),
    ).toEqual({ name: "Home Mistral" });
    expect(JSON.stringify(f.record.mock.calls)).not.toMatch(
      /fixture-key|apiKey|credential/i,
    );
  });

  it("stores bounded private name history and restores only the latest change", async () => {
    const f = fixture();
    const changed = await f.rename.prepare("account-1", "Home Mistral", true);
    const changedResult = await f.rename.confirm(
      changed.action!.sessionId,
      changed.action!.confirmationId,
      true,
    );
    expect(changedResult).toMatchObject({ ok: true, verified: true });
    const listed = f.rename.listHistory("account-1");
    expect(listed.revisions).toHaveLength(1);
    const original = listed.revisions[0]!;
    expect(original).toMatchObject({
      provider: "mistral",
      beforeName: "Personal",
      afterName: "Home Mistral",
    });
    expect(fs.statSync(f.historyFile).mode & 0o777).toBe(0o600);
    const rollback = await f.rename.prepareRollback(
      "account-1",
      original.id,
      true,
    );
    expect(rollback).toMatchObject({
      ok: true,
      oldName: "Home Mistral",
      newName: "Personal",
    });
    const result = await f.rename.confirm(
      rollback.action!.sessionId,
      rollback.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      name: "Personal",
    });
    const revisions = f.rename.listHistory("account-1").revisions;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      beforeName: "Home Mistral",
      afterName: "Personal",
      revertedFrom: original.id,
    });
    await expect(
      f.rename.prepareRollback("account-1", original.id, true),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("later gewijzigd"),
    });
  });

  it("does not store names that the secret sanitizer would redact", async () => {
    const f = fixture();
    const prepared = await f.rename.prepare(
      "account-1",
      "Bearer fixture-secret-value",
      true,
    );
    const result = await f.rename.confirm(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      historyWarning: expect.stringContaining("op geheimen lijken"),
    });
    expect(f.rename.listHistory("account-1").revisions).toEqual([]);
  });

  it("refuses rollback when the account changes after its fresh confirmation is prepared", async () => {
    const f = fixture();
    const changed = await f.rename.prepare("account-1", "Home Mistral", true);
    await f.rename.confirm(
      changed.action!.sessionId,
      changed.action!.confirmationId,
      true,
    );
    const revision = f.rename.listHistory("account-1").revisions[0]!;
    const rollback = await f.rename.prepareRollback(
      "account-1",
      revision.id,
      true,
    );
    const writesBefore = f.request.mock.calls.filter(
      ([, options]) => options?.method === "PUT",
    ).length;
    f.db
      .prepare(
        "UPDATE provider_connections SET name='Changed elsewhere' WHERE id=?",
      )
      .run("account-1");
    const result = await f.rename.confirm(
      rollback.action!.sessionId,
      rollback.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("gewijzigd sinds voorbereiding"),
    });
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PUT"),
    ).toHaveLength(writesBefore);
    expect(
      f.db
        .prepare("SELECT name FROM provider_connections WHERE id=?")
        .get("account-1"),
    ).toEqual({ name: "Changed elsewhere" });
  });

  it("rejects duplicate names and changed accounts before writing", async () => {
    const duplicate = fixture();
    duplicate.db
      .prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)")
      .run("account-2", "mistral", "HOME MISTRAL", 1, "rev-1");
    await expect(
      duplicate.rename.prepare("account-1", "Home Mistral", true),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("bestaat al"),
    });

    const stale = fixture();
    const prepared = await stale.rename.prepare(
      "account-1",
      "Home Mistral",
      true,
    );
    stale.db
      .prepare(
        "UPDATE provider_connections SET name='Changed elsewhere' WHERE id=?",
      )
      .run("account-1");
    const result = await stale.rename.confirm(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("gewijzigd"),
    });
    expect(
      stale.request.mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(false);
  });

  it("cancels cleanly and reports uncertain persistence without claiming success", async () => {
    const cancelled = fixture();
    const prepared = await cancelled.rename.prepare(
      "account-1",
      "Home Mistral",
      true,
    );
    await expect(
      cancelled.rename.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        false,
      ),
    ).resolves.toEqual({ ok: true });
    expect(
      cancelled.request.mock.calls.some(
        ([, options]) => options?.method === "PUT",
      ),
    ).toBe(false);

    const uncertain = fixture();
    uncertain.setPersist(false);
    const pending = await uncertain.rename.prepare(
      "account-1",
      "Home Mistral",
      true,
    );
    await expect(
      uncertain.rename.confirm(
        pending.action!.sessionId,
        pending.action!.confirmationId,
        true,
      ),
    ).resolves.toMatchObject({ ok: false, verified: null });
  });
});
