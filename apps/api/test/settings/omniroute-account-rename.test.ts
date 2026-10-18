import crypto from "node:crypto";
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
import { OmniRouteAccountRename } from "../../src/settings/omniroute-account-rename.service.js";
import { dbStat } from "../helpers/nova-db.js";

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

describe("OmniRoute provider account rename (single step)", () => {
  it("does not expose diagnostics that contain a known validation phrase", async () => {
    const f = fixture();
    const diagnostic = "bestaat al /private/omniroute token=marker";
    f.request.mockRejectedValueOnce(new Error(diagnostic));
    const result = await f.rename.rename("account-1", "Home Mistral");
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(diagnostic);
  });

  it("rejects invalid input without any gateway call", async () => {
    const f = fixture();
    await expect(f.rename.rename("account-1", "  ")).rejects.toThrow(
      "accountnaam",
    );
    await expect(f.rename.rename("../x", "Name")).rejects.toThrow(
      "accountnaam",
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("updates only the name in one call and verifies OmniRoute against SQLite", async () => {
    const f = fixture();
    const result = await f.rename.rename("account-1", "Home Mistral");
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      id: "account-1",
      name: "Home Mistral",
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-key|apiKey/);
    expect(f.request).toHaveBeenCalledWith("/api/providers/account-1", {
      method: "PUT",
      body: { name: "Home Mistral" },
    });
    expect(
      f.db
        .prepare("SELECT name FROM provider_connections WHERE id='account-1'")
        .get(),
    ).toEqual({ name: "Home Mistral" });
    expect(
      f.record.mock.calls.every(([r]) => r.confirmation === "direct"),
    ).toBe(true);
    expect(JSON.stringify(f.record.mock.calls)).not.toMatch(
      /fixture-key|apiKey|credential/i,
    );
  });

  it("stores bounded private name history and restores only the latest change in one step", async () => {
    const f = fixture();
    expect(await f.rename.rename("account-1", "Home Mistral")).toMatchObject({
      ok: true,
      verified: true,
    });
    const listed = f.rename.listHistory("account-1");
    expect(listed.revisions).toHaveLength(1);
    const original = listed.revisions[0]!;
    expect(original).toMatchObject({
      provider: "mistral",
      beforeName: "Personal",
      afterName: "Home Mistral",
    });
    expect(dbStat(f.historyFile).mode & 0o777).toBe(0o600);
    const result = await f.rename.rollback("account-1", original.id);
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
      f.rename.rollback("account-1", original.id),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("later gewijzigd"),
    });
  });

  it("does not store names that the secret sanitizer would redact", async () => {
    const f = fixture();
    const result = await f.rename.rename(
      "account-1",
      "Bearer fixture-secret-value",
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      historyWarning: expect.stringContaining("op geheimen lijken"),
    });
    expect(f.rename.listHistory("account-1").revisions).toEqual([]);
  });

  it("refuses rollback when the account was renamed elsewhere", async () => {
    const f = fixture();
    await f.rename.rename("account-1", "Home Mistral");
    const revision = f.rename.listHistory("account-1").revisions[0]!;
    const writesBefore = f.request.mock.calls.filter(
      ([, options]) => options?.method === "PUT",
    ).length;
    f.db
      .prepare(
        "UPDATE provider_connections SET name='Changed elsewhere' WHERE id=?",
      )
      .run("account-1");
    const result = await f.rename.rollback("account-1", revision.id);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("gewijzigd sinds de geschiedenis"),
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

  it("hides unexpected errors during a rollback and rejects a missing revision", async () => {
    const f = fixture();
    await f.rename.rename("account-1", "Home Mistral");
    const revision = f.rename.listHistory("account-1").revisions[0]!;
    const diagnostic = "private-host.local /private/omniroute token=marker";
    vi.spyOn(f.rename, "rename").mockRejectedValueOnce(new Error(diagnostic));
    const result = await f.rename.rollback("account-1", revision.id);
    expect(result).toEqual({ ok: false, error: "Herstel niet beschikbaar." });
    expect(JSON.stringify(result)).not.toContain(diagnostic);
    expect(
      await f.rename.rollback("account-1", crypto.randomUUID()),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("bestaat niet"),
    });
  });

  it("rejects duplicate names before writing", async () => {
    const duplicate = fixture();
    duplicate.db
      .prepare("INSERT INTO provider_connections VALUES(?,?,?,?,?)")
      .run("account-2", "mistral", "HOME MISTRAL", 1, "rev-1");
    await expect(
      duplicate.rename.rename("account-1", "Home Mistral"),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("bestaat al"),
    });
    expect(
      duplicate.request.mock.calls.some(
        ([, options]) => options?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("reports uncertain persistence without claiming success", async () => {
    const uncertain = fixture();
    uncertain.setPersist(false);
    await expect(
      uncertain.rename.rename("account-1", "Home Mistral"),
    ).resolves.toMatchObject({ ok: false, verified: null });
  });
});
