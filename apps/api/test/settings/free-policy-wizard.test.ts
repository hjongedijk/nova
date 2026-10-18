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
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
} from "../../src/routing/routing.service.js";
import { FreePolicyWizardController } from "../../src/settings/free-policy-wizard.controller.js";
import { FreePolicyWizard } from "../../src/settings/free-policy-wizard.service.js";

const connectionId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const modelId = "llama-3.3-70b-versatile";
const canonical = `groq/${modelId}`;
const officialSource = "https://console.groq.com/docs/rate-limits";
const input = () => ({
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
            allowedModels: ["auto", canonical],
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
    audit,
    barrier,
  );
  const apply = (value: unknown = input()) => wizard.apply(value);
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
    routing,
    barrier,
    configured,
    request,
    wizard,
    apply,
    expectBlocked,
    publicPrivate,
  };
}

describe("free policy wizard options and validation", () => {
  it("projects read-only safe options without credentials, hashes, source attestations or eligibility claims", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT * FROM key_value").all();
    expect(await f.wizard.options()).toEqual({
      available: true,
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
      expect(await f.apply()).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    {},
    { ...input(), always: true },
    { ...input(), acknowledgeBillingDisabled: true },
    { ...input(), inventoryToken: "x" },
    { ...input(), selection: [] },
    {
      ...input(),
      selection: [{ connectionId, modelId, officialSource, extra: true }],
    },
  ])("rejects strict malformed shapes %j", async (value) => {
    const f = fixture();
    await expect(f.apply(value)).rejects.toThrow(ValidationError);
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(fs.existsSync(f.marker)).toBe(false);
  });
});

describe("free policy wizard apply and proof failures", () => {
  it("applies the policy in one call and writes an audit trail without secrets", async () => {
    const f = fixture();
    expect(await f.apply()).toMatchObject({
      ok: true,
      verified: true,
      routeReady: true,
    });
    expect(f.record).toHaveBeenCalled();
    f.publicPrivate(f.record.mock.calls);
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      2,
    );
  });

  it("blocks writes when before_execute auditing fails", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "before_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.apply()).toMatchObject({ ok: false });
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
  });

  it("records bounded private policy-only history without secret material", async () => {
    const f = fixture();
    expect(await f.apply()).toMatchObject({ ok: true, verified: true });
    expect(await f.apply()).toMatchObject({
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
    expect(await f.apply()).toMatchObject({ ok: true });
    fs.chmodSync(path.join(f.dir, "free-policy-history"), 0o755);
    expect(() => f.wizard.history()).toThrow("History directory unavailable");
  });

  it("does not prepare a selected account excluded from NOVA auto routing", async () => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO auto_candidate_overrides VALUES (?,'auto',?,1)")
      .run(keyId, connectionId);
    expect(await f.apply()).toMatchObject({
      ok: false,
    });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
  });

  it("retains the process inference stop and prevents PATCH when marker persistence fails", async () => {
    const f = fixture();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("fixture marker failure");
    });
    expect(await f.apply()).toMatchObject({ ok: false });
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(f.routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => f.routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
  });

  it.each(["echo", "CAS409", "partial-key", "wrong-key-fields"])(
    "keeps inference blocked when native persistence %s",
    async (failure) => {
      const f = fixture();
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
      expect(await f.apply()).toMatchObject({
        ok: false,
        verified: null,
        routeReady: false,
      });
      f.expectBlocked();
      expect(fs.readFileSync(f.policyFile, "utf8")).toBe(f.oldPolicy);
      expect(fs.existsSync(`${f.policyFile}.backup`)).toBe(false);
      expect(await f.apply()).toMatchObject({ ok: false });
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
      expect(await f.apply()).toMatchObject({
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
            allowedModels: ["auto", canonical],
            allowedCombos: [],
            allowedConnections: [connectionId],
            allowAutoCombos: true,
          },
        ],
      ]);
    },
  );

  it.each(["absent", "economic-exclusion", "other-account"])(
    "treats native free-access fields as no economic proof: %s",
    async (scenario) => {
      const f = fixture();
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
      expect(await f.apply()).toMatchObject({
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
      const rename = vi.spyOn(fs, "renameSync");
      if (auditFails)
        f.record.mockImplementation((entry) => {
          if (entry.phase === "after_execute")
            throw new Error("fixture final audit failure");
          return { ...entry, id: "fixture", timestamp: "fixture" };
        });
      const result = await f.apply();
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
    },
  );

  it("does not publish a partially written backup and retries with the intact original policy", async () => {
    const f = fixture();
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
    expect(await f.apply()).toMatchObject({
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
    expect(await f.apply()).toMatchObject({
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
  it("delegates the single apply route straight to the service", () => {
    const service = { apply: vi.fn(() => ({ ok: true })) };
    const controller = new FreePolicyWizardController(
      service as unknown as FreePolicyWizard,
    );
    expect(controller.apply(input())).toEqual({ ok: true });
    expect(service.apply).toHaveBeenCalledWith(input());
  });
});
