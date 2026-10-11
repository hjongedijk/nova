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
import { connectionFingerprint } from "../../src/routing/connection-binding.js";
import { RoutingManagementBarrier } from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
} from "../../src/routing/routing.service.js";
import { FreePolicyWizardController } from "../../src/settings/free-policy-wizard.controller.js";
import { FreePolicyWizard } from "../../src/settings/free-policy-wizard.service.js";
import { ADMIN, createApp } from "./helpers.js";

const connectionId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const modelId = "llama-3.3-70b-versatile";
const canonical = `groq/${modelId}`;
const officialSource = "https://console.groq.com/docs/rate-limits";
const initialNow = 1_700_000_000_000;
const acknowledgements = {
  acknowledgeBillingDisabled: true,
  acknowledgeHardStop: true,
  acknowledgeTerms: true,
  acknowledgeAllClients: true,
  acknowledgeQuotaRefresh: true,
};
const input = () => ({
  ...acknowledgements,
  selection: [{ connectionId, modelId, officialSource }],
});
const model = {
  provider: "groq",
  modelId,
  displayName: "Bearer private-display-name",
  freeType: "recurring-daily",
  tos: "caution",
  apiKey: "private-catalog-secret",
};
const candidate = () => ({
  provider: "groq",
  model: canonical,
  modelStr: canonical,
  connectionId,
  freeAccessExclusion: null,
  reachable: true,
  excluded: false,
  breakerState: "CLOSED",
  connectionCooldown: false,
  modelLocked: false,
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-free-wizard-"));
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE key_value(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key));
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,key TEXT,is_active INTEGER,revoked_at TEXT,model_access_mode TEXT,allowed_models TEXT,allowed_connections TEXT,allowed_combos TEXT,allow_auto_combos INTEGER);
    CREATE TABLE provider_connections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,is_active INTEGER,auth_type TEXT,api_key TEXT);
    CREATE TABLE auto_candidate_overrides(api_key_id TEXT,auto_channel TEXT,connection_id TEXT,excluded INTEGER);`);
  const transaction = (work: () => void) => {
    db.exec("BEGIN");
    try {
      work();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const set = (name: string, value: unknown) =>
    db
      .prepare("INSERT OR REPLACE INTO key_value VALUES ('settings',?,?)")
      .run(name, JSON.stringify(value));
  transaction(() => {
    db.prepare("INSERT INTO provider_connections VALUES (?,?,?,?,?,?)").run(
      connectionId,
      "groq",
      "Bearer private-account-name",
      1,
      "apikey",
      "fixture-credential-alpha",
    );
    db.prepare("INSERT INTO provider_connections VALUES (?,?,?,?,?,?)").run(
      otherId,
      "paid-provider",
      "Other account",
      1,
      "apikey",
      "fixture-credential-beta",
    );
    db.prepare(
      "INSERT INTO api_keys VALUES (?,?,1,NULL,'unrestricted','[]','[]','[]',0)",
    ).run(keyId, "fixture-nova-key");
    set("_settingsRevision", 7);
    set("freeAccessPolicy", "off");
    set("hidePaidModels", false);
    set("excludeTosAvoid", false);
    set("modelVisibilityAllowlist", []);
    set("blockedProviders", ["legacy-provider"]);
  });
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    omniKey: "fixture-nova-key",
    omniModel: "auto",
    freeOnly: true,
    dataFile: (name: string) => path.join(dir, name),
  };
  const policyFile = config.dataFile("free-routing-policy.json");
  const marker = config.dataFile("free-routing-management-block.json");
  const oldPolicy = '{"status":"old-policy"}\n';
  fs.writeFileSync(policyFile, oldPolicy);
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  let now = initialNow;
  confirmations.now = () => now;
  const routing = new RoutingService(config as NovaConfig);
  const barrier = new RoutingManagementBarrier(config as NovaConfig, routing);
  const configured = vi.fn(() => true);
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
  type Options = { method: string; body: Record<string, unknown> };
  const request = vi.fn(
    async (endpoint: string, options?: Options): Promise<unknown> => {
      if (endpoint === "/api/free-models")
        return {
          models: [
            model,
            { ...model, provider: "trial-provider", freeType: "trial" },
            { ...model, provider: "avoid-provider", tos: "avoid" },
          ],
        };
      expectBlocked();
      if (endpoint === "/api/settings") {
        expect(options?.method).toBe("PATCH");
        const body = options!.body;
        const current = JSON.parse(
          (
            db
              .prepare(
                "SELECT value FROM key_value WHERE key='_settingsRevision'",
              )
              .get() as { value: string }
          ).value,
        );
        if (body.expectedRevision !== current)
          throw new Error("409 fixture CAS conflict");
        transaction(() => {
          for (const [name, value] of Object.entries(body))
            if (name !== "expectedRevision") set(name, value);
          set("_settingsRevision", current + 1);
        });
        return { ok: true };
      }
      if (endpoint === `/api/keys/${keyId}`) {
        const body = options!.body;
        if (body.modelAccessMode === "restricted")
          expect(body).toMatchObject({
            modelAccessMode: "restricted",
            allowedModels: ["auto"],
            allowedConnections: [connectionId],
            allowAutoCombos: true,
          });
        transaction(() => {
          db.prepare(
            "UPDATE api_keys SET model_access_mode=?,allowed_models=?,allowed_connections=?,allowed_combos=?,allow_auto_combos=? WHERE id=?",
          ).run(
            body.modelAccessMode as string,
            JSON.stringify(body.allowedModels),
            JSON.stringify(body.allowedConnections),
            JSON.stringify(body.allowedCombos),
            body.allowAutoCombos ? 1 : 0,
            keyId,
          );
        });
        return { ok: true };
      }
      if (endpoint === "/api/v1/auto-combo/auto/candidates") {
        expect(fs.existsSync(policyFile)).toBe(true);
        return { channel: "auto", candidates: [candidate()] };
      }
      throw new Error("Unexpected fixture endpoint");
    },
  );
  const management = {
    get configured() {
      return configured();
    },
    request,
  };
  const wizard = new FreePolicyWizard(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    confirmations,
    audit,
    barrier,
  );
  cleanups.push(() => wizard.onModuleDestroy());
  const validInput = async () => {
    const options = await wizard.options();
    const inventoryToken = (options as unknown as { inventoryToken?: string })
      .inventoryToken;
    if (!options.available || !inventoryToken)
      throw new Error("Missing fixture inventory token");
    return { ...input(), inventoryToken };
  };
  const prepare = async () => {
    const result = await wizard.prepare(await validInput());
    expect(result.ok).toBe(true);
    if (!result.action) throw new Error("Missing fixture approval");
    return result.action;
  };
  const approve = (
    action: Awaited<ReturnType<typeof prepare>>,
    approval = true,
  ) => wizard.confirm(action.sessionId, action.confirmationId, approval);
  const publicPrivate = (value: unknown) => {
    const exposed = JSON.stringify(value);
    for (const secret of [
      "fixture-credential-alpha",
      "fixture-credential-beta",
      "fixture-nova-key",
      "private-account-name",
      "private-display-name",
      "private-catalog-secret",
      officialSource,
    ])
      expect(exposed).not.toContain(secret);
  };
  return {
    dir,
    db,
    transaction,
    set,
    config,
    policyFile,
    marker,
    oldPolicy,
    record,
    confirmations,
    routing,
    barrier,
    configured,
    request,
    wizard,
    validInput,
    prepare,
    approve,
    expectBlocked,
    publicPrivate,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("free policy wizard preparation", () => {
  it.each(["missing", "invalid", "tampered", "expired", "other-instance"])(
    "rejects %s inventory acknowledgement before catalog or writes",
    async (failure) => {
      const f = fixture();
      const value: Record<string, unknown> = await f.validInput();
      if (failure === "missing") delete value.inventoryToken;
      if (failure === "invalid") value.inventoryToken = "invalid-token";
      if (failure === "tampered")
        value.inventoryToken = `${String(value.inventoryToken).slice(0, -1)}${String(value.inventoryToken).endsWith("a") ? "b" : "a"}`;
      if (failure === "expired") f.advance(600000);
      if (failure === "other-instance")
        value.inventoryToken = (await fixture().validInput()).inventoryToken;
      f.request.mockClear();
      expect(await f.wizard.prepare(value)).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it.each(["credential", "account", "key", "settings", "policy", "override"])(
    "rejects %s drift between loaded options and prepare",
    async (change) => {
      const f = fixture();
      const value = await f.validInput();
      if (change === "credential")
        f.db
          .prepare(
            "UPDATE provider_connections SET api_key='rotated' WHERE id=?",
          )
          .run(connectionId);
      if (change === "account")
        f.db
          .prepare("UPDATE provider_connections SET is_active=0 WHERE id=?")
          .run(connectionId);
      if (change === "key")
        f.db
          .prepare("UPDATE api_keys SET allowed_models='[\"changed\"]'")
          .run();
      if (change === "settings") f.set("hidePaidModels", true);
      if (change === "policy") fs.writeFileSync(f.policyFile, "changed");
      if (change === "override")
        f.db
          .prepare("INSERT INTO auto_candidate_overrides VALUES (?,'auto',?,1)")
          .run(keyId, connectionId);
      f.request.mockClear();
      expect(await f.wizard.prepare(value)).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it("rejects each missing required operator acknowledgement before reading the catalog", async () => {
    const f = fixture();
    for (const acknowledgement of Object.keys(acknowledgements)) {
      const value: Record<string, unknown> = input();
      delete value[acknowledgement];
      await expect(f.wizard.prepare(value)).rejects.toThrow(ValidationError);
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it("projects read-only safe options without credentials, hashes, source attestations or eligibility claims", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT * FROM key_value").all();
    expect(await f.wizard.options()).toEqual({
      available: true,
      inventoryToken: expect.any(String),
      verified: false,
      accounts: [
        { id: connectionId, provider: "groq", name: "[redacted]" },
        { id: otherId, provider: "paid-provider", name: "Other account" },
      ],
      models: [
        {
          provider: "groq",
          modelId,
          name: "[redacted]",
          freeType: "recurring-daily",
          tos: "caution",
        },
      ],
    });
    expect(f.request.mock.calls).toEqual([["/api/free-models"]]);
    expect(f.db.prepare("SELECT * FROM key_value").all()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it.each(["provenance", "configured", "route", "database"])(
    "fails options and preparation closed for %s",
    async (failure) => {
      const f = fixture();
      if (failure === "provenance") f.config.omniUrl += "/changed";
      if (failure === "configured") f.configured.mockReturnValue(false);
      if (failure === "route") f.config.omniModel = "other";
      if (failure === "database") f.config.omniDatabase += ".missing";
      expect(await f.wizard.options()).toMatchObject({
        available: false,
        accounts: [],
        models: [],
        verified: false,
      });
      expect(await f.wizard.prepare(input())).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(acknowledgements))(
    "requires %s before requests or writes",
    async (ack) => {
      const f = fixture();
      await expect(
        f.wizard.prepare({ ...input(), [ack]: false }),
      ).rejects.toThrow(ValidationError);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    {},
    { ...input(), always: true },
    { ...input(), selection: [] },
    {
      ...input(),
      selection: [{ connectionId, modelId, officialSource, extra: true }],
    },
  ])("rejects strict malformed shapes %j", async (value) => {
    const f = fixture();
    const withToken =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, inventoryToken: (await f.validInput()).inventoryToken }
        : value;
    await expect(f.wizard.prepare(withToken)).rejects.toThrow(ValidationError);
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("prepares dangerous unique sixty-second metadata approvals while the source, fingerprints and draft remain private", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT * FROM api_keys").all();
    const first = await f.prepare();
    const second = await f.prepare();
    expect(first).toMatchObject({
      tool: "free_policy_replace",
      risk: "DANGEROUS",
      allowAlways: false,
      createdAt: initialNow,
      expiresAt: initialNow + 60000,
      args: {
        models: [canonical],
        accounts: 1,
        evidenceSource: "operator-account",
        nativeQuotaVerified: false,
      },
    });
    expect(Object.keys(first.args).sort()).toEqual([
      "accounts",
      "evidenceSource",
      "models",
      "nativeQuotaVerified",
    ]);
    expect(first.sessionId).toMatch(/^settings-policy:/);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.confirmationId).not.toBe(second.confirmationId);
    f.publicPrivate([first, second, f.record.mock.calls]);
    expect(JSON.stringify([first, f.record.mock.calls])).not.toMatch(
      /[a-f0-9]{64}/,
    );
    expect(f.db.prepare("SELECT * FROM api_keys").all()).toEqual(before);
    expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it("erases private drafts autonomously at expiry, cleans shutdown timers and frees capacity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const state = f.wizard as unknown as {
      drafts: Map<string, unknown>;
      timers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const action = await f.prepare();
    expect(state.drafts.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    f.advance(59999);
    vi.advanceTimersByTime(59999);
    expect(state.drafts.size).toBe(1);
    f.advance(1);
    vi.advanceTimersByTime(1);
    expect(state.drafts.size).toBe(0);
    expect(state.timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.publicPrivate(f.confirmations.peek(action.sessionId));
    await f.prepare();
    f.wizard.onModuleDestroy();
    expect(state.drafts.size).toBe(0);
    expect(state.timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the twenty-draft cap after concurrently awaiting catalog requests", async () => {
    const f = fixture();
    const value = await f.validInput();
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (endpoint, options) => {
      await gate;
      return original(endpoint, options);
    });
    const pending = Array.from({ length: 25 }, () => f.wizard.prepare(value));
    release();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(results.filter((result) => !result.ok)).toHaveLength(5);
    f.advance(60000);
    expect((await f.wizard.prepare(await f.validInput())).ok).toBe(true);
  });
});

describe("free policy wizard confirmation and proof failures", () => {
  it("rejects malformed session and confirmation identifiers without requests", async () => {
    const f = fixture();
    await expect(
      f.wizard.confirm("chat-session", crypto.randomUUID(), true),
    ).rejects.toThrow(ValidationError);
    await expect(
      f.wizard.confirm(
        `settings-policy:${crypto.randomUUID()}`,
        "bad-id",
        true,
      ),
    ).rejects.toThrow(ValidationError);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("records bounded private policy-only history without secret material", async () => {
    const f = fixture();
    const action = await f.prepare();
    expect(await f.approve(action)).toMatchObject({ ok: true, verified: true });
    const nextAction = await f.prepare();
    expect(await f.approve(nextAction)).toMatchObject({
      ok: true,
      verified: true,
    });
    const history = f.wizard.history();
    expect(history.revisions).toHaveLength(2);
    const serializedHistory = JSON.stringify(history);
    expect(serializedHistory).not.toContain("fixture-credential-alpha");
    expect(serializedHistory).not.toContain("fixture-credential-beta");
    expect(serializedHistory).not.toContain("fixture-nova-key");
    expect(serializedHistory).not.toMatch(/[a-f0-9]{64}/);
    expect(
      fs.statSync(path.join(f.dir, "free-policy-history", "history.json"))
        .mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(f.dir, "free-policy-history")).mode & 0o777,
    ).toBe(0o700);
    expect(f.routing.status()).toMatchObject({ ready: true });
    expect(
      f.db.prepare("SELECT model_access_mode FROM api_keys").get(),
    ).toEqual({ model_access_mode: "restricted" });
    expect(JSON.parse(fs.readFileSync(f.policyFile, "utf8"))).toMatchObject({
      status: "OK",
    });
  });

  it("rejects history directories with broader permissions", async () => {
    const f = fixture();
    const action = await f.prepare();
    expect(await f.approve(action)).toMatchObject({ ok: true });
    fs.chmodSync(path.join(f.dir, "free-policy-history"), 0o755);
    expect(() => f.wizard.history()).toThrow("History directory unavailable");
  });

  it("does not prepare a selected account excluded from NOVA auto routing", async () => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO auto_candidate_overrides VALUES (?,'auto',?,1)")
      .run(keyId, connectionId);
    expect(await f.wizard.prepare(await f.validInput())).toMatchObject({
      ok: false,
    });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
  });

  it("retains the process inference stop and prevents PATCH when marker persistence fails", async () => {
    const f = fixture();
    const action = await f.prepare();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("fixture marker failure");
    });
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
  });

  it("rejects mismatched sessions and cancels without native or policy writes", async () => {
    const f = fixture();
    const first = await f.prepare();
    const second = await f.prepare();
    expect(
      await f.wizard.confirm(second.sessionId, first.confirmationId, true),
    ).toMatchObject({ ok: false });
    expect(
      await f.wizard.confirm(
        `settings-policy:${crypto.randomUUID()}`,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(await f.approve(first, false)).toEqual({ ok: true });
    expect(await f.approve(first)).toMatchObject({ ok: false });
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.publicPrivate(f.record.mock.calls);
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it.each([60000, 60001])(
    "rejects expired confirmation at %i ms without writes",
    async (elapsed) => {
      const f = fixture();
      const action = await f.prepare();
      f.advance(elapsed);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    },
  );

  it.each(["credential", "provider", "settings", "key", "policy", "override"])(
    "rejects stale %s before writes",
    async (change) => {
      const f = fixture();
      const action = await f.prepare();
      if (change === "credential")
        f.db
          .prepare(
            "UPDATE provider_connections SET api_key='rotated' WHERE id=?",
          )
          .run(connectionId);
      if (change === "provider")
        f.db
          .prepare(
            "UPDATE provider_connections SET provider='changed' WHERE id=?",
          )
          .run(connectionId);
      if (change === "settings") f.set("hidePaidModels", true);
      if (change === "key")
        f.db
          .prepare("UPDATE api_keys SET allowed_models='[\"changed\"]'")
          .run();
      if (change === "policy") fs.writeFileSync(f.policyFile, "changed");
      if (change === "override")
        f.db
          .prepare("INSERT INTO auto_candidate_overrides VALUES (?,'auto',?,1)")
          .run(keyId, connectionId);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it.each(["echo", "CAS409", "partial-key", "wrong-key-fields"])(
    "keeps inference blocked when native persistence %s",
    async (failure) => {
      const f = fixture();
      const action = await f.prepare();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (endpoint, options) => {
        if (!options) return original(endpoint, options);
        f.expectBlocked();
        if (failure === "echo") return { ok: true };
        if (failure === "CAS409" && endpoint === "/api/settings")
          throw new Error("409 fixture CAS");
        if (failure === "partial-key" && endpoint.startsWith("/api/keys/"))
          throw new Error("fixture partial failure");
        const result = await original(endpoint, options);
        if (failure === "wrong-key-fields" && endpoint.startsWith("/api/keys/"))
          f.db
            .prepare(
              "UPDATE api_keys SET allowed_connections=NULL,allowed_models='[]'",
            )
            .run();
        return result;
      });
      expect(await f.approve(action)).toMatchObject({
        ok: false,
        verified: null,
        routeReady: false,
      });
      f.expectBlocked();
      expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
      expect(fs.existsSync(`${f.policyFile}.backup`)).toBe(false);
      expect(await f.approve(action)).toMatchObject({ ok: false });
    },
  );

  it.each([
    "null",
    "empty",
    "multiple",
    "wrong-account",
    "wrong-model",
    "excluded",
    "not-reachable",
    "breaker",
    "cooldown",
    "locked",
  ])(
    "cannot activate policy with invalid selected native account structure %s",
    async (failure) => {
      const f = fixture();
      const action = await f.prepare();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (endpoint, options) => {
        if (endpoint !== "/api/v1/auto-combo/auto/candidates")
          return original(endpoint, options);
        f.expectBlocked();
        const row: Record<string, unknown> = candidate();
        if (failure === "null") return null;
        if (failure === "empty") return { channel: "auto", candidates: [] };
        if (failure === "multiple")
          return {
            channel: "auto",
            candidates: [row, { ...row }],
          };
        if (failure === "wrong-account") row.connectionId = otherId;
        if (failure === "wrong-model") row.modelStr = "groq/other";
        if (failure === "excluded") row.excluded = true;
        if (failure === "not-reachable") row.reachable = false;
        if (failure === "breaker") row.breakerState = "OPEN";
        if (failure === "cooldown") row.connectionCooldown = true;
        if (failure === "locked") row.modelLocked = true;
        return { channel: "auto", candidates: [row] };
      });
      expect(await f.approve(action)).toMatchObject({
        ok: false,
        verified: null,
        routeReady: false,
      });
      f.expectBlocked();
      expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
      expect(fs.existsSync(`${f.policyFile}.backup`)).toBe(false);
      expect(
        f.request.mock.calls
          .filter(([, options]) => options)
          .map(([endpoint, options]) => [endpoint, options!.body]),
      ).toEqual([
        [
          "/api/settings",
          {
            expectedRevision: 7,
            freeAccessPolicy: "strict",
            hidePaidModels: true,
            excludeTosAvoid: true,
            modelVisibilityAllowlist: [canonical],
            blockedProviders: ["legacy-provider", "paid-provider"],
          },
        ],
        [
          `/api/keys/${keyId}`,
          {
            modelAccessMode: "restricted",
            connectionAccessMode: "restricted",
            allowedModels: ["auto"],
            allowedCombos: [],
            allowedConnections: [connectionId],
            allowAutoCombos: true,
          },
        ],
      ]);
    },
  );

  it.each(["prepare", "before_execute"])(
    "blocks writes on %s audit failure",
    async (phase) => {
      const f = fixture();
      const action = phase === "before_execute" ? await f.prepare() : undefined;
      f.record.mockImplementation((entry) => {
        if (phase === "prepare" || entry.phase === phase)
          throw new Error("fixture audit failure");
        return { ...entry, id: "fixture", timestamp: "fixture" };
      });
      expect(
        action
          ? await f.approve(action)
          : await f.wizard.prepare(await f.validInput()),
      ).toMatchObject({ ok: false });
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it("consumes overlapping approval while native settings PATCH is pending", async () => {
    const f = fixture();
    const first = await f.prepare();
    const second = await f.prepare();
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (endpoint, options) => {
      if (endpoint === "/api/settings") {
        f.expectBlocked();
        await gate;
        throw new Error("fixture delayed failure");
      }
      return original(endpoint, options);
    });
    const pending = f.approve(first);
    try {
      expect(await f.approve(second)).toMatchObject({ ok: false });
      expect(f.confirmations.has(second.sessionId)).toBe(false);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ ok: false, verified: null });
    expect(await f.approve(second)).toMatchObject({ ok: false });
    f.expectBlocked();
  });

  it("rejects old attestations after pre-prepare rotation, then binds renewed attestations without claiming cached SAFE quota verification", async () => {
    const f = fixture();
    const oldInput = await f.validInput();
    const rotatedCredential = "fixture-rotated-before-prepare";
    f.db
      .prepare("UPDATE provider_connections SET api_key=? WHERE id=?")
      .run(rotatedCredential, connectionId);
    expect(await f.wizard.prepare(oldInput)).toMatchObject({ ok: false });
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(fs.existsSync(f.marker)).toBe(false);
    const action = await f.prepare();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (endpoint, options) => {
      if (endpoint !== "/api/v1/auto-combo/auto/candidates")
        return original(endpoint, options);
      f.expectBlocked();
      return {
        channel: "auto",
        candidates: [
          {
            ...candidate(),
            freeAccessExclusion: null,
            nativeQuota: {
              status: "SAFE",
              fetchedAt: "2000-01-01T00:00:00Z",
              credentialFingerprint: "old-credential-cache",
            },
          },
        ],
      };
    });
    expect(await f.approve(action)).toEqual({
      ok: true,
      verified: true,
      routeReady: true,
      evidenceSource: "operator-account",
      nativeQuotaVerified: false,
    });
    const policy = JSON.parse(fs.readFileSync(f.policyFile, "utf8"));
    expect(policy.verifiedConnections).toEqual([
      {
        id: connectionId,
        provider: "groq",
        fingerprint: connectionFingerprint({
          id: connectionId,
          provider: "groq",
          auth_type: "apikey",
          api_key: rotatedCredential,
        }),
      },
    ]);
    expect(policy.catalog[0]).toMatchObject({
      billingVerified: true,
      hardStopGuaranteed: true,
      accountFreeVerified: true,
      nativeAutoEligible: true,
    });
    expect(policy.catalog[0]).not.toHaveProperty("nativeQuota");
    expect(fs.readFileSync(f.policyFile, "utf8")).not.toContain(
      rotatedCredential,
    );
    for (const [entry] of f.record.mock.calls)
      if (entry.tool === "free_policy_replace" && entry.arguments)
        expect(entry.arguments).toMatchObject({
          evidenceSource: "operator-account",
          nativeQuotaVerified: false,
        });
    expect(f.routing.assertFree()).toMatchObject({
      ready: true,
      policyVerified: true,
      freeOnly: true,
    });
  });

  it.each(["absent", "economic-exclusion", "other-account"])(
    "treats native free-access fields as no economic proof: %s",
    async (scenario) => {
      const f = fixture();
      const action = await f.prepare();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (endpoint, options) => {
        if (endpoint !== "/api/v1/auto-combo/auto/candidates")
          return original(endpoint, options);
        f.expectBlocked();
        const row: Record<string, unknown> = candidate();
        if (scenario === "absent") delete row.freeAccessExclusion;
        if (scenario === "economic-exclusion")
          row.freeAccessExclusion = "quota-proof-unavailable";
        return {
          channel: "auto",
          candidates:
            scenario === "other-account"
              ? [row, { ...row, connectionId: otherId, excluded: true }]
              : [row],
        };
      });
      expect(await f.approve(action)).toMatchObject({
        ok: true,
        verified: true,
        routeReady: true,
        evidenceSource: "operator-account",
        nativeQuotaVerified: false,
      });
      expect(fs.existsSync(f.marker)).toBe(false);
    },
  );

  it.each([false, true])(
    "saves an atomic private policy and backup after structural proof, with post-audit failure=%s",
    async (auditFails) => {
      const f = fixture();
      const action = await f.prepare();
      const rename = vi.spyOn(fs, "renameSync");
      if (auditFails)
        f.record.mockImplementation((entry) => {
          if (entry.phase === "after_execute")
            throw new Error("fixture final audit failure");
          return { ...entry, id: "fixture", timestamp: "fixture" };
        });
      const result = await f.approve(action);
      expect(result).toMatchObject({
        ok: true,
        verified: true,
        routeReady: true,
        evidenceSource: "operator-account",
        nativeQuotaVerified: false,
      });
      if (auditFails) expect(result.auditWarning).toEqual(expect.any(String));
      else expect(result.auditWarning).toBeUndefined();
      expect(fs.statSync(f.policyFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${f.policyFile}.backup`).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(`${f.policyFile}.backup`, "utf8")).toBe(
        f.oldPolicy,
      );
      expect(
        rename.mock.calls.some(
          ([from, to]) =>
            String(from).startsWith(`${f.policyFile}.`) &&
            String(from).endsWith(".tmp") &&
            to === f.policyFile,
        ),
      ).toBe(true);
      expect(
        fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      const policy = JSON.parse(fs.readFileSync(f.policyFile, "utf8"));
      expect(policy).toMatchObject({
        nativeFreeAccessPolicy: "strict",
        enabledModels: [canonical],
        verifiedConnectionIds: [connectionId],
        nativeModelAllowlist: [canonical],
      });
      expect(policy.catalog[0].nativeAutoEligible).toBe(true);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(
        new RoutingService(f.config as NovaConfig).assertFree().ready,
      ).toBe(true);
      f.publicPrivate(f.record.mock.calls);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(
        f.request.mock.calls.filter(([, options]) => options),
      ).toHaveLength(2);
    },
  );

  it("does not publish a partially written backup and retries with the intact original policy", async () => {
    const f = fixture();
    const action = await f.prepare();
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    let backupDescriptor: number | undefined;
    const open = vi
      .spyOn(fs, "openSync")
      .mockImplementation((filename, flags, mode) => {
        const descriptor = originalOpen(filename, flags, mode);
        if (String(filename).startsWith(`${f.policyFile}.backup.`))
          backupDescriptor = descriptor;
        return descriptor;
      });
    const write = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((filename, content, options) => {
        if (filename === backupDescriptor) {
          originalWrite(filename, Buffer.from(f.oldPolicy).subarray(0, 4));
          throw new Error("fixture partial backup write");
        }
        originalWrite(filename, content, options);
      });
    expect(await f.approve(action)).toMatchObject({
      ok: false,
      verified: null,
      routeReady: false,
    });
    f.expectBlocked();
    expect(fs.existsSync(`${f.policyFile}.backup`)).toBe(false);
    expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
    expect(
      fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    open.mockRestore();
    write.mockRestore();
    expect(await f.approve(await f.prepare())).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(fs.readFileSync(`${f.policyFile}.backup`, "utf8")).toBe(f.oldPolicy);
    expect(fs.statSync(`${f.policyFile}.backup`).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(f.marker)).toBe(false);
  });
});

describe("free policy wizard HTTP boundary", () => {
  it("rejects malformed and standing approval confirmation bodies before delegation", () => {
    const service = { confirm: vi.fn() };
    const controller = new FreePolicyWizardController(
      service as unknown as FreePolicyWizard,
    );
    for (const body of [
      null,
      [],
      {},
      { sessionId: "s", confirmationId: "c", approve: "yes" },
      { sessionId: "s", confirmationId: "c", approve: true, always: true },
    ])
      expect(() => controller.confirm(body)).toThrow(ValidationError);
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("requires PIN for reads and PIN plus admin for writes with no model policy setter", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const wizard = nova.app.get(FreePolicyWizard);
    const options = vi.spyOn(wizard, "options").mockResolvedValue({
      available: true,
      verified: false,
      accounts: [],
      models: [],
    });
    const prepare = vi.spyOn(wizard, "prepare").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(wizard, "confirm").mockResolvedValue({ ok: true });
    const history = vi.spyOn(wizard, "history").mockReturnValue({
      revisions: [],
      truncated: false,
    });
    try {
      expect(
        nova.tools.forModel().map((tool) => tool.function.name),
      ).not.toContain("free_policy_replace");
      expect(
        nova.tools
          .forModel()
          .filter((tool) =>
            /policy.*(?:set|replace)|(?:set|replace).*policy/i.test(
              tool.function.name,
            ),
          ),
      ).toEqual([]);
      for (const [route, body] of [
        ["prepare", input()],
        [
          "confirm",
          {
            sessionId: `settings-policy:${crypto.randomUUID()}`,
            confirmationId: crypto.randomUUID(),
            approve: true,
          },
        ],
      ] as const) {
        const endpoint = `/api/settings/omniroute/policy/${route}`;
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
      expect(
        (await nova.api.get("/api/settings/omniroute/policy").set(ADMIN))
          .status,
      ).toBe(401);
      expect(
        (
          await nova.api
            .get("/api/settings/omniroute/policy/history")
            .set(ADMIN)
        ).status,
      ).toBe(401);
      expect(options).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(
        (
          await nova.api
            .get("/api/settings/omniroute/policy/history")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
        ).status,
      ).toBe(200);
      expect(history).toHaveBeenCalledOnce();
      expect(
        (
          await nova.api
            .get("/api/settings/omniroute/policy")
            .set("x-nova-pin", "4321")
        ).status,
      ).toBe(200);
      expect(
        (
          await nova.api
            .get("/api/settings/omniroute/policy")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
        ).status,
      ).toBe(200);
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/policy/prepare")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send(input())
        ).status,
      ).toBe(200);
    } finally {
      options.mockRestore();
      prepare.mockRestore();
      confirm.mockRestore();
      history.mockRestore();
      await nova.app.close();
    }
  });
});
