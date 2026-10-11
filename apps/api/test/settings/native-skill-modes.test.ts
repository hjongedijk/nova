import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeSkillMode } from "@nova/contracts";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
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
import { ADMIN, createApp } from "./helpers.js";

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
  const confirmations = new ConfirmationsService(audit);
  let now = 1000;
  confirmations.now = () => now;
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
    confirmations,
    audit,
  );
  const prepare = (
    mode: NativeSkillMode = "off",
    id = "skill-1",
    acknowledgeGlobal = false,
  ) => {
    const result = service.prepare(id, mode, acknowledgeGlobal);
    expect(result.ok).toBe(true);
    if (!result.action) throw new Error("Missing fixture confirmation");
    return result.action;
  };
  const approve = (
    action: ReturnType<typeof prepare>,
    approved = true,
    id = "skill-1",
  ) => service.confirm(id, action.sessionId, action.confirmationId, approved);
  return {
    db,
    config,
    record,
    confirmations,
    service,
    management: management as unknown as OmniRouteManagement,
    audit,
    prepare,
    approve,
    update,
    request,
    scope,
    configured,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("native skill mode approvals", () => {
  it("records secret-free mode history and rolls back the latest change only", async () => {
    const f = fixture();
    const action = f.prepare("off");
    expect(await f.approve(action)).toMatchObject({ ok: true, verified: true });
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

    const rollback = f.service.prepareRollback(
      "skill-1",
      history.revisions[0]!.id,
    );
    expect(rollback).toMatchObject({ ok: true, scope: "nova" });
    expect(rollback.action?.risk).toBe("DANGEROUS");
    const result = await f.approve(rollback.action!);
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
    const first = f.prepare("off");
    await f.approve(first);
    const older = f.service.history("skill-1").revisions[0]!;
    const second = f.prepare("on");
    await f.approve(second);
    expect(f.service.prepareRollback("skill-1", older.id)).toMatchObject({
      ok: false,
      error: "Herstel alleen de nieuwste skillwijziging.",
    });
    const latest = f.service.history("skill-1").revisions[0]!;
    f.update("mode", "auto");
    f.update("enabled", 1);
    f.update("updated_at", "external-change");
    expect(f.service.prepareRollback("skill-1", latest.id)).toMatchObject({
      ok: false,
      error: "De skill is ondertussen gewijzigd. Laad de geschiedenis opnieuw.",
    });
  });

  it("requires client-wide acknowledgement and dangerous confirmation when restoring a shared skill", async () => {
    const f = fixture();
    const action = f.prepare("off", "system", true);
    expect(await f.approve(action, true, "system")).toMatchObject({
      ok: true,
      verified: true,
    });
    const revision = f.service.history("system").revisions[0]!;
    expect(f.service.prepareRollback("system", revision.id)).toMatchObject({
      ok: false,
      error: "Bevestig eerst dat de wijziging alle gateway-clients raakt.",
    });
    const rollback = f.service.prepareRollback("system", revision.id, true);
    expect(rollback.action?.risk).toBe("DANGEROUS");
    expect(await f.approve(rollback.action!, true, "system")).toMatchObject({
      ok: true,
      verified: true,
      mode: "auto",
    });
    expect(f.service.history("system").revisions[0]?.scope).toBe("global");
  });

  it("requires explicit global-impact acknowledgement and DANGEROUS confirmation for shared skills", async () => {
    const f = fixture();
    expect(f.service.prepare("system", "off")).toMatchObject({
      ok: false,
      error: "Bevestig eerst dat de wijziging alle gateway-clients raakt.",
    });
    expect(f.request).not.toHaveBeenCalled();
    const prepared = f.service.prepare("system", "off", true);
    expect(prepared).toMatchObject({
      ok: true,
      scope: "global",
      name: "Fixture skill",
    });
    expect(prepared.action).toMatchObject({
      tool: "native_skill_mode",
      risk: "DANGEROUS",
      allowAlways: false,
      args: { id: "system", mode: "off" },
    });
    const action = prepared.action!;
    expect(
      f.db.prepare("SELECT mode FROM skills WHERE id='system'").get(),
    ).toEqual({ mode: "auto" });
    expect(await f.approve(action, true, "system")).toEqual({
      ok: true,
      verified: true,
      mode: "off",
      enabled: false,
    });
    expect(f.request).toHaveBeenCalledWith("/api/skills/system", {
      method: "PUT",
      body: { mode: "off" },
    });
    expect(
      f.db.prepare("SELECT mode FROM skills WHERE id='system'").get(),
    ).toEqual({ mode: "off" });
  });

  it("prepares a 60-second, unique session-bound approval without writing or standing consent", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT * FROM skills").all();
    const first = f.prepare();
    const second = f.prepare("on");
    expect(first).toMatchObject({
      tool: "native_skill_mode",
      risk: "CONFIRM",
      allowAlways: false,
      createdAt: 1000,
      expiresAt: 61000,
      args: { id: "skill-1", mode: "off" },
    });
    expect(first.sessionId).toMatch(/^settings-native:/);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.confirmationId).not.toBe(second.confirmationId);
    expect(first.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f.db.prepare("SELECT * FROM skills").all()).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      await f.service.confirm(
        "skill-1",
        second.sessionId,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await f.service.confirm(
        "system",
        first.sessionId,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await f.service.confirm(
        "skill-1",
        `settings-native:${crypto.randomUUID()}`,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.confirmations.has(first.sessionId)).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["on", "off", "auto"] as const)(
    "persists and reads back %s once",
    async (mode) => {
      const f = fixture();
      const action = f.prepare(mode);
      expect(action.risk).toBe(mode === "off" ? "CONFIRM" : "DANGEROUS");
      expect(action.allowAlways).toBe(false);
      expect(await f.approve(action)).toEqual({
        ok: true,
        verified: true,
        mode,
        enabled: mode !== "off",
      });
      expect(f.request.mock.calls).toEqual([
        ["/api/skills/skill-1", { method: "PUT", body: { mode } }],
      ]);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(
        f.record.mock.calls.map(([entry]) => entry.phase).filter(Boolean),
      ).toEqual(["before_execute", "after_execute"]);
    },
  );

  it.each([false, true])(
    "consumes concurrent approval and releases the skill guard after write failure=%s",
    async (failWrite) => {
      const f = fixture();
      const first = f.prepare("off");
      const second = f.prepare("on");
      const persist = f.request.getMockImplementation();
      if (!persist) throw new Error("Missing fixture persistence");
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.request.mockImplementationOnce(async (endpoint, options) => {
        await delayed;
        if (failWrite) throw new Error("Fixture write failure");
        return persist(endpoint, options);
      });
      const pending = f.approve(first);
      try {
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(await f.approve(second)).toEqual({
          ok: false,
          error:
            "Deze skill wordt al gewijzigd. Kies de wijziging opnieuw zodra die klaar is.",
        });
        expect(f.confirmations.has(second.sessionId)).toBe(false);
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(
          f.db.prepare("SELECT mode FROM skills WHERE id='skill-1'").get(),
        ).toMatchObject({ mode: "auto" });
      } finally {
        release();
      }
      expect(await pending).toMatchObject(
        failWrite
          ? { ok: false, verified: null }
          : { ok: true, verified: true, mode: "off", enabled: false },
      );
      expect(await f.approve(second)).toMatchObject({ ok: false });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(await f.approve(f.prepare("on"))).toEqual({
        ok: true,
        verified: true,
        mode: "on",
        enabled: true,
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([59999, 60000, 60001])(
    "enforces the exact expiry boundary at %i ms",
    async (elapsed) => {
      const f = fixture();
      const action = f.prepare();
      f.advance(elapsed);
      expect((await f.approve(action)).ok).toBe(elapsed < 60000);
      expect(f.request).toHaveBeenCalledTimes(elapsed < 60000 ? 1 : 0);
      expect(f.confirmations.has(action.sessionId)).toBe(false);
    },
  );

  it("cancels without writing and consumes the approval", async () => {
    const f = fixture();
    const action = f.prepare();
    expect(await f.approve(action, false)).toEqual({ ok: true });
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ confirmation: "rejected_admin_ui" }),
    );
  });

  it.each(["system", "skillsmp", "skillssh", "foreign", "missing"])(
    "rejects non-owned skill %s",
    (id) => {
      const f = fixture();
      expect(f.service.prepare(id, "off")).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["handler", "changed-handler"],
    ["schema", '{"type":"string"}'],
    ["name", "Renamed"],
    ["mode", "on"],
    ["api_key_id", "foreign"],
    ["updated_at", "revision-new"],
    ["enabled", 0],
  ] as const)(
    "invalidates approval after %s changes",
    async (column, value) => {
      const f = fixture();
      const action = f.prepare();
      f.update(column, value);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.confirmations.has(action.sessionId)).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["provenance", "password", "database"])(
    "fails closed before requests when %s is unavailable",
    async (failure) => {
      const f = fixture();
      const action = f.prepare();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "password") f.configured.mockReturnValue(false);
      if (failure === "database")
        f.config.omniDatabase = path.join(
          path.dirname(f.config.omniDatabase),
          "absent.sqlite",
        );
      expect(f.service.prepare("skill-1", "on")).toMatchObject({ ok: false });
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["prepare", "before_execute"])(
    "audit failure at %s blocks writes",
    async (phase) => {
      const f = fixture();
      const action = phase === "before_execute" ? f.prepare() : undefined;
      f.record.mockImplementation((entry) => {
        if (phase === "prepare" || entry.phase === phase)
          throw new Error("fixture audit failure");
        return { ...entry, id: "fixture", timestamp: "fixture" };
      });
      expect(
        action ? await f.approve(action) : f.service.prepare("skill-1", "off"),
      ).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["echo", "mode", "enabled", "binding"])(
    "does not report verified success for incorrect persistence: %s",
    async (failure) => {
      const f = fixture();
      const action = f.prepare();
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
      expect(await f.approve(action)).toMatchObject({
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
    const action = f.prepare();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "after_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.approve(action)).toMatchObject({
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

describe("native skill removal approvals", () => {
  it("allows preparing removal only for a NOVA-owned skill", () => {
    const f = fixture();
    const removal = new NativeSkillRemoval(
      f.config as NovaConfig,
      f.management,
      f.confirmations,
      f.audit,
    );
    const own = removal.prepare("skill-1");
    expect(own).toMatchObject({
      ok: true,
      name: "Fixture skill",
      action: { risk: "DANGEROUS", tool: "native_skill_remove" },
    });
    expect(removal.prepare("system")).toMatchObject({ ok: false });
    expect(removal.prepare("foreign")).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("deletes only after fresh approval and independently verifies SQLite removal", async () => {
    const f = fixture();
    const removal = new NativeSkillRemoval(
      f.config as NovaConfig,
      f.management,
      f.confirmations,
      f.audit,
    );
    const prepared = removal.prepare("skill-1");
    if (!prepared.action) throw new Error("Missing removal confirmation");
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      removal.confirm(
        "skill-1",
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).resolves.toMatchObject({ ok: true, verified: true });
    expect(f.request).toHaveBeenCalledWith("/api/skills/skill-1", {
      method: "DELETE",
    });
    expect(
      f.db.prepare("SELECT id FROM skills WHERE id=?").get("skill-1"),
    ).toBeUndefined();
  });

  it("rejects stale revisions before calling OmniRoute", async () => {
    const f = fixture();
    const removal = new NativeSkillRemoval(
      f.config as NovaConfig,
      f.management,
      f.confirmations,
      f.audit,
    );
    const prepared = removal.prepare("skill-1");
    if (!prepared.action) throw new Error("Missing removal confirmation");
    f.update("name", "Changed after prepare");
    await expect(
      removal.confirm(
        "skill-1",
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("native skill mode validation and API guard", () => {
  it.each(["always", "ON", "", null, 1, {}])(
    "rejects unknown mode %j",
    (mode) => {
      const f = fixture();
      expect(() => f.service.prepare("skill-1", mode)).toThrow(ValidationError);
      expect(f.scope).not.toHaveBeenCalled();
    },
  );

  it.each(["../skill", "skill?x=1", "", "a".repeat(101)])(
    "rejects malformed skill id %s",
    async (id) => {
      const f = fixture();
      expect(() => f.service.prepare(id, "off")).toThrow(ValidationError);
      await expect(
        f.service.confirm(id, "session", "confirmation", true),
      ).rejects.toThrow(ValidationError);
      expect(f.scope).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["chat-session", crypto.randomUUID()],
    [`settings-native:${crypto.randomUUID()}`, "invalid"],
  ])("rejects malformed session/confirmation %s %s", async (session, id) => {
    const f = fixture();
    await expect(
      f.service.confirm("skill-1", session, id, true),
    ).rejects.toThrow(ValidationError);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects extra fields, malformed bodies and standing approval requests before delegation", () => {
    const service = {
      prepare: vi.fn(),
      prepareRollback: vi.fn(),
      confirm: vi.fn(),
      history: vi.fn(),
    };
    const controller = new NativeSkillModesController(
      service as unknown as NativeSkillModesService,
    );
    for (const body of [null, [], { mode: "off", always: true }])
      expect(() => controller.prepare("skill-1", body)).toThrow(
        ValidationError,
      );
    for (const body of [
      null,
      [],
      {},
      { sessionId: "s", confirmationId: "c", approve: "yes" },
      { sessionId: "s", confirmationId: "c", approve: true, always: true },
    ])
      expect(() => controller.confirm("skill-1", body)).toThrow(
        ValidationError,
      );
    for (const body of [null, [], {}, { revisionId: "bad", extra: true }])
      expect(() => controller.prepareRollback("skill-1", body)).toThrow(
        ValidationError,
      );
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.prepareRollback).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("requires PIN and admin header on every history and mutation route", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const service = nova.app.get(NativeSkillModesService);
    const prepare = vi.spyOn(service, "prepare").mockReturnValue({ ok: true });
    const confirm = vi
      .spyOn(service, "confirm")
      .mockResolvedValue({ ok: true });
    const prepareRollback = vi
      .spyOn(service, "prepareRollback")
      .mockReturnValue({ ok: true });
    const history = vi
      .spyOn(service, "history")
      .mockReturnValue({ revisions: [], truncated: false });
    try {
      for (const [route, body] of [
        ["prepare", { mode: "off" }],
        ["rollback/prepare", { revisionId: crypto.randomUUID() }],
        [
          "confirm",
          {
            sessionId: `settings-native:${crypto.randomUUID()}`,
            confirmationId: crypto.randomUUID(),
            approve: true,
          },
        ],
      ] as const) {
        const endpoint = `/api/settings/omniroute/native/skills/skill-1/${route}`;
        expect(
          (await nova.api.post(endpoint).set(ADMIN).send(body)).status,
        ).toBe(401);
        expect(
          (
            await nova.api
              .post(endpoint)
              .set(ADMIN)
              .set("x-nova-pin", "wrong")
              .send(body)
          ).status,
        ).toBe(401);
        expect(
          (await nova.api.post(endpoint).set("x-nova-pin", "4321").send(body))
            .status,
        ).toBe(403);
        expect(prepare).not.toHaveBeenCalled();
        expect(prepareRollback).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
      }
      const historyRoute =
        "/api/settings/omniroute/native/skills/skill-1/history";
      expect((await nova.api.get(historyRoute).set(ADMIN)).status).toBe(401);
      expect(
        (await nova.api.get(historyRoute).set(ADMIN).set("x-nova-pin", "wrong"))
          .status,
      ).toBe(401);
      expect(
        (await nova.api.get(historyRoute).set("x-nova-pin", "4321")).status,
      ).toBe(200);
      expect(history).toHaveBeenCalledWith("skill-1");
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/native/skills/skill-1/prepare")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send({ mode: "off" })
        ).status,
      ).toBe(200);
      expect(
        (await nova.api.get(historyRoute).set(ADMIN).set("x-nova-pin", "4321"))
          .status,
      ).toBe(200);
      expect(
        (
          await nova.api
            .post(
              "/api/settings/omniroute/native/skills/skill-1/rollback/prepare",
            )
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send({ revisionId: crypto.randomUUID(), acknowledgeGlobal: false })
        ).status,
      ).toBe(200);
      expect(prepareRollback).toHaveBeenCalledWith(
        "skill-1",
        expect.any(String),
        false,
      );
      const body = {
        sessionId: `settings-native:${crypto.randomUUID()}`,
        confirmationId: crypto.randomUUID(),
        approve: true,
      };
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/native/skills/skill-1/confirm")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send(body)
        ).status,
      ).toBe(200);
      expect(prepare).toHaveBeenCalledWith("skill-1", "off", false);
      expect(confirm).toHaveBeenCalledWith(
        "skill-1",
        body.sessionId,
        body.confirmationId,
        true,
      );
    } finally {
      prepare.mockRestore();
      prepareRollback.mockRestore();
      confirm.mockRestore();
      history.mockRestore();
      await nova.app.close();
    }
  });
});
