import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeSkillMode } from "@nova/contracts";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativeSkillModesController } from "../../src/settings/native-skill-modes.controller.js";
import { NativeSkillModesService } from "../../src/settings/native-skill-modes.service.js";
import { NativeSkillRemoval } from "../../src/settings/native-skill-removal.service.js";

const gateway = "http://fixture.invalid/v1";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-native-modes-"));
  const database = path.join(dir, "skills.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`BEGIN; CREATE TABLE skills (
    id TEXT PRIMARY KEY, api_key_id TEXT, name TEXT, handler TEXT,
    schema TEXT, mode TEXT, enabled INTEGER, updated_at TEXT
  );`);
  const insert = db.prepare("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)");
  for (const owner of [
    "nova-owner",
    "system",
    "skillsmp",
    "skillssh",
    "foreign",
  ])
    insert.run(
      owner === "nova-owner" ? "skill-1" : owner,
      owner,
      "Fixture skill",
      "fixture-handler",
      '{"type":"object"}',
      "auto",
      1,
      "revision-1",
    );
  db.exec("COMMIT");
  const config = {
    omniUrl: gateway,
    verifiedOmniUrl: gateway,
    omniDatabase: database,
    dataFile: (name: string) => path.join(dir, name),
  };
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const scope = vi.fn(() => "nova-owner");
  const configured = vi.fn(() => true);
  const update = (column: string, value: string | number, id = "skill-1") => {
    if (
      ![
        "api_key_id",
        "name",
        "handler",
        "schema",
        "mode",
        "enabled",
        "updated_at",
      ].includes(column)
    )
      throw new Error("Invalid fixture column");
    db.prepare(`UPDATE skills SET ${column}=? WHERE id=?`).run(value, id);
  };
  const request = vi.fn(
    async (
      endpoint: string,
      options: { method: string; body?: { mode?: NativeSkillMode } },
    ) => {
      db.exec("BEGIN");
      try {
        const id = decodeURIComponent(endpoint.split("/").at(-1) ?? "");
        if (options.method === "DELETE")
          db.prepare("DELETE FROM skills WHERE id=?").run(id);
        else {
          update("mode", options.body?.mode ?? "auto", id);
          update("enabled", options.body?.mode === "off" ? 0 : 1, id);
          update("updated_at", "revision-2", id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return options.method === "DELETE" ? {} : { mode: options.body?.mode };
    },
  );
  const management = {
    get configured() {
      return configured();
    },
    get scope() {
      return scope();
    },
    request,
  };
  const service = new NativeSkillModesService(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    audit,
  );
  return {
    db,
    config,
    record,
    service,
    management: management as unknown as OmniRouteManagement,
    audit,
    update,
    request,
    scope,
    configured,
  };
}

describe("native skill mode changes (single step)", () => {
  it("records secret-free mode history and rolls back the latest change in one call", async () => {
    const f = fixture();
    expect(await f.service.setMode("skill-1", "off")).toMatchObject({
      ok: true,
      verified: true,
      mode: "off",
      scope: "nova",
    });
    const history = f.service.history("skill-1");
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({
      before: "auto",
      after: "off",
      scope: "nova",
    });
    const historyFile = path.join(
      path.dirname(f.config.omniDatabase),
      "native-skill-mode-history.json",
    );
    expect(fs.statSync(historyFile).mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(historyFile, "utf8");
    expect(stored).not.toContain("fixture-handler");
    expect(stored).not.toContain("object");

    const result = await f.service.rollback(
      "skill-1",
      history.revisions[0]!.id,
    );
    expect(result).toMatchObject({ ok: true, verified: true, mode: "auto" });
    const after = f.service.history("skill-1");
    expect(after.revisions).toHaveLength(2);
    expect(after.revisions[0]).toMatchObject({
      before: "off",
      after: "auto",
      revertedFrom: history.revisions[0]!.id,
    });
  });

  it("rejects stale or older native skill mode history", async () => {
    const f = fixture();
    await f.service.setMode("skill-1", "off");
    const first = f.service.history("skill-1").revisions[0]!;
    await f.service.setMode("skill-1", "on");
    expect(await f.service.rollback("skill-1", first.id)).toMatchObject({
      ok: false,
    });
    f.update("updated_at", "external-change");
    const latest = f.service.history("skill-1").revisions[0]!;
    expect(await f.service.rollback("skill-1", latest.id)).toMatchObject({
      ok: false,
    });
    await expect(f.service.rollback("skill-1", "bad")).rejects.toThrow(
      ValidationError,
    );
  });

  it.each(["on", "off", "auto"] as const)(
    "sets mode %s immediately and verifies SQLite",
    async (mode) => {
      const f = fixture();
      f.update("mode", mode === "auto" ? "on" : "auto");
      const result = await f.service.setMode("skill-1", mode);
      expect(result).toMatchObject({ ok: true, verified: true, mode });
      expect(f.request).toHaveBeenCalledWith("/api/skills/skill-1", {
        method: "PUT",
        body: { mode },
      });
      expect(
        f.db.prepare("SELECT mode FROM skills WHERE id='skill-1'").get(),
      ).toMatchObject({ mode });
      expect(f.record).toHaveBeenCalled();
    },
  );

  it("serialises overlapping changes of the same skill and releases the guard", async () => {
    const f = fixture();
    const persist = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async () => {
      await gate;
      throw new Error("fixture failure");
    });
    const pending = f.service.setMode("skill-1", "off");
    expect(await f.service.setMode("skill-1", "on")).toMatchObject({
      ok: false,
      error: expect.stringContaining("al gewijzigd"),
    });
    release();
    expect(await pending).toMatchObject({ ok: false, verified: null });
    f.request.mockImplementation(persist);
    expect(await f.service.setMode("skill-1", "off")).toMatchObject({
      ok: true,
    });
  });

  it.each(["system", "skillsmp", "skillssh", "foreign", "missing"])(
    "shared or unknown skill %s is handled without writing for non-allowed owners",
    async (id) => {
      const f = fixture();
      const result = await f.service.setMode(id, "off");
      if (id === "foreign" || id === "missing") {
        expect(result).toMatchObject({ ok: false });
        expect(f.request).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: true, scope: "global" });
      }
    },
  );

  it.each(["provenance", "password", "database"])(
    "fails closed before requests when %s is unavailable",
    async (failure) => {
      const f = fixture();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "password") f.configured.mockReturnValue(false);
      if (failure === "database")
        f.config.omniDatabase = path.join(
          path.dirname(f.config.omniDatabase),
          "absent.sqlite",
        );
      expect(await f.service.setMode("skill-1", "on")).toMatchObject({
        ok: false,
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("audit failure at before_execute blocks writes", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "before_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.service.setMode("skill-1", "off")).toMatchObject({
      ok: false,
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["echo", "mode", "enabled", "binding"])(
    "does not report verified success for incorrect persistence: %s",
    async (failure) => {
      const f = fixture();
      f.request.mockImplementation(async () => {
        if (failure !== "echo") {
          f.update("mode", "off");
          f.update("enabled", 0);
        }
        if (failure === "mode") f.update("mode", "on");
        if (failure === "enabled") f.update("enabled", 1);
        if (failure === "binding") f.update("handler", "changed-handler");
        return { mode: "off" };
      });
      expect(await f.service.setMode("skill-1", "off")).toMatchObject({
        ok: false,
        verified: null,
      });
      expect(f.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ verification: { persisted: null } }),
      );
    },
  );

  it("reports verified saved state honestly if the final audit fails", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "after_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.service.setMode("skill-1", "off")).toMatchObject({
      ok: true,
      verified: true,
      mode: "off",
      enabled: false,
      auditWarning: expect.any(String),
    });
    expect(
      f.db.prepare("SELECT mode,enabled FROM skills WHERE id='skill-1'").get(),
    ).toMatchObject({ mode: "off", enabled: 0 });
  });
});

describe("native skill removal (single step)", () => {
  const removal = (f: ReturnType<typeof fixture>) =>
    new NativeSkillRemoval(f.config as NovaConfig, f.management, f.audit);

  it("refuses to remove anything that is not a NOVA-owned skill", async () => {
    const f = fixture();
    expect(await removal(f).remove("system")).toMatchObject({ ok: false });
    expect(await removal(f).remove("foreign")).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("deletes in one call and independently verifies SQLite removal", async () => {
    const f = fixture();
    await expect(removal(f).remove("skill-1")).resolves.toMatchObject({
      ok: true,
      verified: true,
      name: "Fixture skill",
    });
    expect(f.request).toHaveBeenCalledWith("/api/skills/skill-1", {
      method: "DELETE",
    });
    expect(
      f.db.prepare("SELECT id FROM skills WHERE id=?").get("skill-1"),
    ).toBeUndefined();
    expect(f.record).toHaveBeenCalled();
  });

  it("rejects malformed skill ids", async () => {
    const f = fixture();
    await expect(removal(f).remove("../skill")).rejects.toThrow(
      ValidationError,
    );
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("native skill mode validation and API guard", () => {
  it.each(["always", "ON", "", null, 1, {}])(
    "rejects unknown mode %j",
    async (mode) => {
      const f = fixture();
      await expect(f.service.setMode("skill-1", mode)).rejects.toThrow(
        ValidationError,
      );
      expect(f.scope).not.toHaveBeenCalled();
    },
  );

  it.each(["../skill", "skill?x=1", "", "a".repeat(101)])(
    "rejects malformed skill id %s",
    async (id) => {
      const f = fixture();
      await expect(f.service.setMode(id, "off")).rejects.toThrow(
        ValidationError,
      );
      expect(f.scope).not.toHaveBeenCalled();
    },
  );

  it("rejects extra fields and malformed bodies before delegation", () => {
    const service = {
      setMode: vi.fn(),
      rollback: vi.fn(),
      history: vi.fn(),
    };
    const controller = new NativeSkillModesController(
      service as unknown as NativeSkillModesService,
    );
    for (const body of [
      null,
      [],
      { mode: "off", always: true },
      { mode: "off", acknowledgeGlobal: true },
    ])
      expect(() => controller.setMode("skill-1", body)).toThrow(
        ValidationError,
      );
    for (const body of [null, [], {}, { revisionId: "bad", extra: true }])
      expect(() => controller.rollback("skill-1", body)).toThrow(
        ValidationError,
      );
    expect(service.setMode).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
    controller.setMode("skill-1", { mode: "on" });
    expect(service.setMode).toHaveBeenCalledWith("skill-1", "on");
  });
});
