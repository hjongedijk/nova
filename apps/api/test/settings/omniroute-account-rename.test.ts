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
        expect(options.body).toEqual({ name: "Home Mistral" });
        const nextName = options.body?.name;
        if (typeof nextName !== "string") throw new Error("Missing name");
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
