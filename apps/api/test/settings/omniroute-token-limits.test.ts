import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { OmniRouteTokenLimits } from "../../src/settings/omniroute-token-limits.service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(withLimit = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-token-limits-"));
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE api_keys(id TEXT PRIMARY KEY,name TEXT,key TEXT UNIQUE,is_active INTEGER,revoked_at TEXT)",
  );
  db.exec(
    "CREATE TABLE api_key_token_limits(id TEXT PRIMARY KEY,api_key_id TEXT,scope_type TEXT,scope_value TEXT,token_limit INTEGER,reset_interval TEXT,reset_time TEXT,enabled INTEGER)",
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?)").run(
    "key-1",
    "Shared key",
    "secret-key-value",
    1,
    null,
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?)").run(
    "nova-key-id",
    "NOVA internal",
    "nova-secret",
    1,
    null,
  );
  if (withLimit)
    db.prepare("INSERT INTO api_key_token_limits VALUES(?,?,?,?,?,?,?,?)").run(
      "11111111-1111-4111-8111-111111111111",
      "key-1",
      "global",
      "",
      1000,
      "monthly",
      "00:00",
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
    omniKey: "nova-secret",
    dataFile: (name: string) => path.join(dir, name),
  };
  const auditRecord = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "audit",
    timestamp: "now",
  }));
  const audit = { record: auditRecord } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => 1000;
  let writes = 0;
  const request = vi.fn(
    async (
      endpoint: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      if (endpoint === "/api/keys")
        return {
          keys: [
            {
              id: "key-1",
              name: "Shared key",
              isActive: true,
              key: "must-not-leave-api",
            },
            { id: "nova-key-id", name: "NOVA internal", isActive: true },
          ],
        };
      if (endpoint.startsWith("/api/usage/token-limits?apiKeyId=")) {
        const apiKeyId = decodeURIComponent(endpoint.split("=").at(-1)!);
        const limits = db
          .prepare("SELECT * FROM api_key_token_limits WHERE api_key_id=?")
          .all(apiKeyId)
          .map((row: Record<string, unknown>) => ({
            id: row.id,
            apiKeyId: row.api_key_id,
            scopeType: row.scope_type,
            scopeValue: row.scope_value,
            tokenLimit: row.token_limit,
            resetInterval: row.reset_interval,
            resetTime: row.reset_time || "00:00",
            enabled: row.enabled === 1,
            tokensUsed: 900,
            raw: "must-not-leave-api",
          }));
        return { apiKeyId, limits };
      }
      if (
        endpoint === "/api/usage/token-limits" &&
        options?.method === "POST"
      ) {
        writes++;
        const body = options.body!;
        const keyId = String(body.apiKeyId);
        const scopeType = String(body.scopeType);
        const scopeValue = String(body.scopeValue);
        const tokenLimit = Number(body.tokenLimit);
        const resetInterval = String(body.resetInterval);
        const resetTime = String(body.resetTime);
        const enabled = body.enabled === true;
        const existing = db
          .prepare(
            "SELECT id FROM api_key_token_limits WHERE api_key_id=? AND scope_type=? AND scope_value=?",
          )
          .get(keyId, scopeType, scopeValue) as { id: string } | undefined;
        if (existing)
          db.prepare(
            "UPDATE api_key_token_limits SET token_limit=?,reset_interval=?,reset_time=?,enabled=? WHERE id=?",
          ).run(
            tokenLimit,
            resetInterval,
            resetTime,
            enabled ? 1 : 0,
            existing.id,
          );
        else
          db.prepare(
            "INSERT INTO api_key_token_limits VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            crypto.randomUUID(),
            keyId,
            scopeType,
            scopeValue,
            tokenLimit,
            resetInterval,
            resetTime,
            enabled ? 1 : 0,
          );
        return { success: true };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  );
  const management = {
    configured: true,
    request,
  } as unknown as OmniRouteManagement;
  const service = new OmniRouteTokenLimits(
    config as NovaConfig,
    management,
    confirmations,
    audit,
  );
  return { service, db, request, auditRecord, writes: () => writes };
}

describe("OmniRoute token limits", () => {
  it("projects validated limits without counters, key values, or NOVA's own key", async () => {
    const f = fixture(true);
    const report = await f.service.report("key-1");
    expect(report).toMatchObject({
      available: true,
      keyId: "key-1",
      keyName: "Shared key",
    });
    expect(report.limits).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        scopeType: "global",
        scopeValue: "",
        tokenLimit: 1000,
        resetInterval: "monthly",
        resetTime: "00:00",
        enabled: true,
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /tokensUsed|must-not-leave-api|secret-key-value|nova-secret/,
    );
    expect((await f.service.report("nova-key-id")).available).toBe(false);
    expect((await f.service.report("unknown")).available).toBe(false);
  });

  it("adds a global cap only after fresh client-wide DANGEROUS confirmation and verifies SQLite/API", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("key-1", 5000, "weekly", true);
    expect(prepared).toMatchObject({
      ok: true,
      oldLimit: null,
      tokenLimit: 5000,
      action: { risk: "DANGEROUS" },
    });
    expect(f.writes()).toBe(0);
    expect(JSON.stringify(f.auditRecord.mock.calls)).not.toContain(
      "nova-secret",
    );
    expect(JSON.stringify(prepared.action?.args)).not.toContain(
      "secret-key-value",
    );
    const action = prepared.action!;
    expect(
      await f.service.confirm(
        "key-1",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: true, verified: true });
    expect(
      f.db
        .prepare(
          "SELECT token_limit,reset_interval,enabled FROM api_key_token_limits WHERE api_key_id=?",
        )
        .get("key-1"),
    ).toEqual({ token_limit: 5000, reset_interval: "weekly", enabled: 1 });
    expect(f.writes()).toBe(1);
  });

  it("allows only lowering or enabling an existing cap without changing its interval", async () => {
    const f = fixture(true);
    expect(
      await f.service.prepare("key-1", 1001, "monthly", true),
    ).toMatchObject({ ok: false });
    expect(await f.service.prepare("key-1", 900, "daily", true)).toMatchObject({
      ok: false,
    });
    const prepared = await f.service.prepare("key-1", 900, "monthly", true);
    expect(prepared).toMatchObject({ ok: true, oldLimit: 1000 });
    expect(f.writes()).toBe(0);
  });

  it("rejects a concurrent upstream change rather than overwriting it", async () => {
    const f = fixture(true);
    const prepared = await f.service.prepare("key-1", 800, "monthly", true);
    const action = prepared.action!;
    f.db
      .prepare("UPDATE api_key_token_limits SET token_limit=? WHERE id=?")
      .run(700, "11111111-1111-4111-8111-111111111111");
    expect(
      await f.service.confirm(
        "key-1",
        action.sessionId,
        action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.writes()).toBe(0);
  });
});
