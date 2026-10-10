import crypto from "node:crypto";
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
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";
import { OmniRouteAccountRemovalController } from "../../src/settings/omniroute-account-removal.controller.js";
import { OmniRouteAccountRemoval } from "../../src/settings/omniroute-account-removal.service.js";
import { ADMIN, createApp } from "./helpers.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-account-removal-"));
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE provider_connections(id TEXT PRIMARY KEY, provider TEXT, name TEXT, is_active INTEGER, updated_at TEXT); BEGIN",
  );
  const insert = db.prepare(
    "INSERT INTO provider_connections VALUES (?,?,?,?,?)",
  );
  insert.run(
    "account-1",
    "provider-1",
    "Bearer private-account-name",
    1,
    "revision-1",
  );
  insert.run("account-2", "provider-2", "Second account", 1, "revision-2");
  db.exec("COMMIT");
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    freeOnly: false,
    dataFile: (name: string) => path.join(dir, name),
  };
  const marker = config.dataFile("free-routing-management-block.json");
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  let now = 1000;
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => now;
  const routing = new RoutingService(config as NovaConfig);
  const verify = vi
    .spyOn(routing, "verifyForManagement")
    .mockReturnValue(verified);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  const configured = vi.fn(() => true);
  const deleted = (id: string) => {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM provider_connections WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const row = (id = "account-1") =>
    db.prepare("SELECT * FROM provider_connections WHERE id=?").get(id);
  const request = vi.fn(
    async (endpoint: string, options: { method: string }) => {
      expect(options).toEqual({ method: "DELETE" });
      expect(routing.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
      expect(new RoutingService(config as NovaConfig).status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({
        version: 1,
        reason: "account_change",
      });
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
      deleted(endpoint.split("/").at(-1)!);
      return { ok: true };
    },
  );
  const management = {
    get configured() {
      return configured();
    },
    request,
  };
  const removal = new OmniRouteAccountRemoval(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    confirmations,
    audit,
    barrier,
    routing,
  );
  const prepare = (id = "account-1") => {
    const result = removal.prepare(id, true);
    expect(result.ok).toBe(true);
    if (!result.action) throw new Error("Missing fixture approval");
    return result.action;
  };
  const approve = (
    action: ReturnType<typeof prepare>,
    approval = true,
    id = String(action.args.id),
  ) => removal.confirm(id, action.sessionId, action.confirmationId, approval);
  const expectBlocked = () => {
    expect(fs.existsSync(marker)).toBe(true);
    for (const instance of [
      routing,
      new RoutingService(config as NovaConfig),
    ]) {
      expect(instance.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => instance.assertFree()).toThrow(FreeRoutingBlockedError);
    }
  };
  return {
    dir,
    db,
    config,
    marker,
    record,
    confirmations,
    routing,
    verify,
    barrier,
    configured,
    deleted,
    row,
    request,
    removal,
    prepare,
    approve,
    expectBlocked,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("OmniRoute account removal approvals", () => {
  it("prepares read-only dangerous unique 60-second approvals with no standing consent or secret metadata", () => {
    const f = fixture();
    const before = f.db.prepare("SELECT * FROM provider_connections").all();
    const result = f.removal.prepare("account-1", true);
    const first = result.action!;
    const second = f.prepare();
    expect(result.name).toBe("[redacted]");
    expect(first).toMatchObject({
      tool: "omniroute_account_remove",
      risk: "DANGEROUS",
      allowAlways: false,
      createdAt: 1000,
      expiresAt: 61000,
      args: {
        id: "account-1",
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(Object.keys(first.args).sort()).toEqual(["id", "revision"]);
    expect(first.sessionId).toMatch(/^settings-account:/);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.confirmationId).not.toBe(second.confirmationId);
    expect(JSON.stringify([result, f.record.mock.calls])).not.toContain(
      "private-account-name",
    );
    expect(f.db.prepare("SELECT * FROM provider_connections").all()).toEqual(
      before,
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("blocks memory and disk before DELETE and releases only after persisted removal and two fresh route checks", async () => {
    const f = fixture();
    const action = f.prepare();
    f.verify.mockImplementation(() => {
      expect(f.row()).toBeUndefined();
      f.expectBlocked();
      return verified;
    });
    expect(await f.approve(action)).toEqual({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(f.request.mock.calls).toEqual([
      ["/api/providers/account-1", { method: "DELETE" }],
    ]);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.row()).toBeUndefined();
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.routing.assertFree().ready).toBe(true);
    expect(new RoutingService(f.config as NovaConfig).assertFree().ready).toBe(
      true,
    );
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "after_execute",
        verification: { persisted: true, routeReady: true },
      }),
    );
  });

  it("rejects cross-account/session/confirmation bindings without consuming valid consent", async () => {
    const f = fixture();
    const first = f.prepare();
    const second = f.prepare("account-2");
    expect(await f.approve(first, true, "account-2")).toMatchObject({
      ok: false,
    });
    expect(
      await f.removal.confirm(
        "account-1",
        second.sessionId,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await f.removal.confirm(
        "account-1",
        `settings-account:${crypto.randomUUID()}`,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await f.removal.confirm(
        "account-1",
        first.sessionId,
        crypto.randomUUID(),
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.confirmations.has(first.sessionId)).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("cancels without any write and consumes the approval", async () => {
    const f = fixture();
    const action = f.prepare();
    expect(await f.approve(action, false)).toEqual({ ok: true });
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.row()).toBeDefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmation: "rejected_admin_ui" }),
    );
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "private-account-name",
    );
  });

  it.each([59999, 60000, 60001])(
    "enforces expiry at %i ms",
    async (elapsed) => {
      const f = fixture();
      const action = f.prepare();
      f.advance(elapsed);
      expect((await f.approve(action)).ok).toBe(elapsed < 60000);
      expect(f.request).toHaveBeenCalledTimes(elapsed < 60000 ? 1 : 0);
      expect(f.confirmations.has(action.sessionId)).toBe(false);
    },
  );

  it.each(["provider", "updated_at", "name", "is_active", "id", "missing"])(
    "rejects stale account binding after %s changes",
    async (column) => {
      const f = fixture();
      const action = f.prepare();
      if (column === "missing") f.deleted("account-1");
      else if (column === "is_active")
        f.db
          .prepare(
            "UPDATE provider_connections SET is_active=0 WHERE id='account-1'",
          )
          .run();
      else
        f.db
          .prepare(
            `UPDATE provider_connections SET ${column}=? WHERE id='account-1'`,
          )
          .run("changed");
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.confirmations.has(action.sessionId)).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it.each(["provenance", "configured", "database"])(
    "checks %s before DELETE",
    async (failure) => {
      const f = fixture();
      const action = f.prepare();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "configured") f.configured.mockReturnValue(false);
      if (failure === "database") f.config.omniDatabase += ".missing";
      expect(f.removal.prepare("account-1", true)).toMatchObject({ ok: false });
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it("consumes and refuses a concurrent approval during a delayed DELETE, then frees operation ownership", async () => {
    const f = fixture();
    const first = f.prepare();
    const second = f.prepare("account-2");
    const persist = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async (endpoint, options) => {
      f.expectBlocked();
      await gate;
      return persist(endpoint, options);
    });
    const pending = f.approve(first);
    try {
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(await f.approve(second)).toMatchObject({ ok: false });
      expect(f.confirmations.has(second.sessionId)).toBe(false);
      expect(f.row("account-2")).toBeDefined();
      expect(f.request).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ ok: true, verified: true });
    expect(await f.approve(second)).toMatchObject({ ok: false });
    expect(await f.approve(f.prepare("account-2"))).toMatchObject({
      ok: true,
      verified: true,
    });
  });

  it.each(["echo", "upstream-after-delete"])(
    "keeps inference durably blocked after unverified deletion: %s",
    async (failure) => {
      const f = fixture();
      const action = f.prepare();
      f.request.mockImplementation(async () => {
        f.expectBlocked();
        if (failure === "upstream-after-delete") {
          f.deleted("account-1");
          throw new Error("fixture upstream failure");
        }
        return { ok: true };
      });
      expect(await f.approve(action)).toMatchObject({
        ok: false,
        verified: null,
        routeReady: false,
      });
      expect(Boolean(f.row())).toBe(failure === "echo");
      f.expectBlocked();
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          verification: { persisted: null, routeReady: false },
        }),
      );
    },
  );

  it.each([
    "not-ready",
    "not-free",
    "not-verified",
    "throws",
    "second-check-fails",
  ])("retains the marker when route proof %s", async (failure) => {
    const f = fixture();
    const action = f.prepare();
    if (failure === "throws")
      f.verify.mockImplementation(() => {
        throw new Error("fixture route failure");
      });
    else if (failure === "second-check-fails")
      f.verify
        .mockReturnValueOnce(verified)
        .mockReturnValue({ ...verified, ready: false });
    else
      f.verify.mockReturnValue({
        ...verified,
        ready: failure !== "not-ready",
        freeOnly: failure !== "not-free",
        policyVerified: failure !== "not-verified",
      });
    expect(await f.approve(action)).toEqual({
      ok: true,
      verified: true,
      routeReady: false,
    });
    expect(f.row()).toBeUndefined();
    f.expectBlocked();
    expect(f.verify).toHaveBeenCalledTimes(
      failure === "second-check-fails" ? 2 : 1,
    );
    f.verify.mockReturnValue(verified);
    await f.barrier.run(async (operation) => {
      expect(operation.releaseAfterVerification()).toEqual(verified);
    });
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.routing.assertFree().ready).toBe(true);
  });

  it.each(["prepare", "before_execute"])(
    "pre-execution audit failure at %s blocks DELETE",
    async (phase) => {
      const f = fixture();
      const action = phase === "before_execute" ? f.prepare() : undefined;
      f.record.mockImplementation((entry) => {
        if (phase === "prepare" || entry.phase === phase)
          throw new Error("fixture audit failure");
        return { ...entry, id: "fixture", timestamp: "fixture" };
      });
      expect(
        action ? await f.approve(action) : f.removal.prepare("account-1", true),
      ).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.row()).toBeDefined();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it("reports verified removal honestly with a final audit warning", async () => {
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
      routeReady: true,
      auditWarning: expect.any(String),
    });
    expect(f.row()).toBeUndefined();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("prevents DELETE and retains the in-memory inference stop when marker persistence fails", async () => {
    const f = fixture();
    const action = f.prepare();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("fixture marker failure");
    });
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.row()).toBeDefined();
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(f.verify).not.toHaveBeenCalled();
  });
});

describe("account removal validation and API boundary", () => {
  it.each([false, undefined, "true", 1, null])(
    "requires explicit acknowledgement: %j",
    (acknowledge) => {
      const f = fixture();
      expect(() => f.removal.prepare("account-1", acknowledge)).toThrow(
        ValidationError,
      );
      expect(f.record).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["../account", "account?x=1", "", "a".repeat(101)])(
    "rejects malformed account id %s",
    async (id) => {
      const f = fixture();
      expect(() => f.removal.prepare(id, true)).toThrow(ValidationError);
      await expect(
        f.removal.confirm(
          id,
          `settings-account:${crypto.randomUUID()}`,
          crypto.randomUUID(),
          true,
        ),
      ).rejects.toThrow(ValidationError);
    },
  );

  it("rejects malformed confirmation sessions and ids", async () => {
    const f = fixture();
    await expect(
      f.removal.confirm("account-1", "chat-session", crypto.randomUUID(), true),
    ).rejects.toThrow(ValidationError);
    await expect(
      f.removal.confirm(
        "account-1",
        `settings-account:${crypto.randomUUID()}`,
        "invalid",
        true,
      ),
    ).rejects.toThrow(ValidationError);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("reports missing accounts without making an approval", () => {
    const f = fixture();
    expect(f.removal.prepare("missing", true)).toMatchObject({ ok: false });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects extra fields and malformed controller bodies before delegation", () => {
    const service = { prepare: vi.fn(), confirm: vi.fn() };
    const controller = new OmniRouteAccountRemovalController(
      service as unknown as OmniRouteAccountRemoval,
    );
    for (const body of [null, [], { acknowledgeEffects: true, always: true }])
      expect(() => controller.prepare("account-1", body)).toThrow(
        ValidationError,
      );
    for (const body of [
      null,
      [],
      {},
      { sessionId: "s", confirmationId: "c", approve: "yes" },
      { sessionId: "s", confirmationId: "c", approve: true, always: true },
    ])
      expect(() => controller.confirm("account-1", body)).toThrow(
        ValidationError,
      );
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("requires PIN and admin on both real app routes and exposes no model removal tool", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const service = nova.app.get(OmniRouteAccountRemoval);
    const prepare = vi.spyOn(service, "prepare").mockReturnValue({ ok: true });
    const confirm = vi
      .spyOn(service, "confirm")
      .mockResolvedValue({ ok: true });
    const confirmation = {
      sessionId: `settings-account:${crypto.randomUUID()}`,
      confirmationId: crypto.randomUUID(),
      approve: true,
    };
    try {
      expect(
        nova.tools.forModel().map((tool) => tool.function.name),
      ).not.toContain("omniroute_account_remove");
      expect(
        nova.tools
          .forModel()
          .filter((tool) =>
            /account.*(?:remove|delete)|(?:remove|delete).*account/i.test(
              tool.function.name,
            ),
          ),
      ).toEqual([]);
      for (const [route, body] of [
        ["prepare", { acknowledgeEffects: true }],
        ["confirm", confirmation],
      ] as const) {
        const endpoint = `/api/settings/omniroute/accounts/account-1/removal/${route}`;
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
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/accounts/account-1/removal/prepare")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send({ acknowledgeEffects: true })
        ).status,
      ).toBe(200);
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/accounts/account-1/removal/confirm")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send(confirmation)
        ).status,
      ).toBe(200);
      expect(prepare).toHaveBeenCalledWith("account-1", true);
      expect(confirm).toHaveBeenCalledWith(
        "account-1",
        confirmation.sessionId,
        confirmation.confirmationId,
        true,
      );
    } finally {
      prepare.mockRestore();
      confirm.mockRestore();
      await nova.app.close();
    }
  });
});
