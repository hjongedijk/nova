import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { connectionFingerprint } from "../../src/routing/connection-binding.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
} from "../../src/routing/routing.service.js";

describe("RoutingService", () => {
  const saved = { free: process.env.FREE_ONLY, env: process.env.NODE_ENV };
  afterEach(() => {
    process.env.FREE_ONLY = saved.free;
    process.env.NODE_ENV = saved.env;
  });

  it("fails closed when the policy or OmniRoute cannot be verified", () => {
    process.env.FREE_ONLY = "true";
    const routing = new RoutingService(new NovaConfig());
    expect(routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_UNAVAILABLE",
    });
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    expect(routing.providerInventory()).toEqual([]);
  });

  it("allows explicit models only while listed in the verified free route", () => {
    const routing = new RoutingService(new NovaConfig());
    vi.spyOn(routing, "assertFree").mockReturnValue({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
      enabledModels: ["provider/free-embed"],
      explicitModels: ["provider/free-embed"],
    });
    expect(routing.assertFreeModel("provider/free-embed")).toBe(
      "provider/free-embed",
    );
    expect(() => routing.assertFreeModel("provider/paid-model")).toThrow(
      FreeRoutingBlockedError,
    );
  });

  it("blocks a persisted gateway redirect before policy lookup and the test bypass", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-gateway-test-"),
    );
    const env = {
      NOVA_DATA_DIR: directory,
      OMNIROUTE_URL: "http://verified-gateway.invalid/v1",
      OMNIROUTE_DATABASE: path.join(directory, "missing-gateway.sqlite"),
      FREE_ONLY: "false",
      NODE_ENV: "test",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, env);
      fs.writeFileSync(
        path.join(directory, "services.json"),
        JSON.stringify({
          version: 1,
          services: { omniroute: { url: "http://other-gateway.invalid/v1" } },
          history: [],
        }),
      );
      const config = new NovaConfig();
      expect(config.verifiedOmniUrl).toBe(env.OMNIROUTE_URL);
      expect(config.omniUrl).toBe("http://other-gateway.invalid/v1");
      const routing = new RoutingService(config);
      expect(routing.status()).toMatchObject({
        ready: false,
        status: "GATEWAY_PROVENANCE_UNVERIFIED",
      });
      expect(routing.verifyForManagement()).toMatchObject({
        ready: false,
        status: "GATEWAY_PROVENANCE_UNVERIFIED",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
      expect(fs.existsSync(env.OMNIROUTE_DATABASE)).toBe(false);
      expect(
        fs.existsSync(path.join(directory, "free-routing-policy.json")),
      ).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("the test bypass exists only under NODE_ENV=test, never in production", () => {
    process.env.FREE_ONLY = "false";
    process.env.NODE_ENV = "production";
    expect(new RoutingService(new NovaConfig()).status().ready).toBe(false);
    process.env.NODE_ENV = "test";
    expect(new RoutingService(new NovaConfig()).status().ready).toBe(true);
  });
});

describe("RoutingService verified SQLite policy", () => {
  let directory: string;
  let db: DatabaseSync;
  let routing: RoutingService;
  let previous: Record<string, string | undefined>;
  const model = "fixture-provider/free-model";
  const connection = {
    id: "fixture-connection",
    provider: "fixture-provider",
    auth_type: "apikey",
    api_key: "fixture-account-secret",
  };
  const candidate = {
    provider: "fixture-provider",
    modelId: "free-model",
    freeType: "recurring-daily",
    billingVerified: true,
    hardStopGuaranteed: true,
    accountFreeVerified: true,
    nativeAutoEligible: true,
    nativeQuota: { status: "SAFE" },
    tos: "allowed",
  };
  const policy = () => ({
    route: "auto",
    enabledModels: [model],
    verifiedProviders: ["fixture-provider"],
    verifiedConnectionIds: ["fixture-connection"],
    blockedProviders: ["paid-provider"],
    nativeModelAllowlist: [model],
    catalog: [{ ...candidate, nativeQuota: { ...candidate.nativeQuota } }],
  });
  const writePolicy = (value: unknown) =>
    fs.writeFileSync(
      path.join(directory, "free-routing-policy.json"),
      JSON.stringify(value),
    );
  const boundPolicy = () => ({
    ...policy(),
    verifiedConnections: [
      {
        id: connection.id,
        provider: connection.provider,
        fingerprint: connectionFingerprint(connection),
      },
    ],
  });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-policy-proof-"));
    const env = {
      NOVA_DATA_DIR: directory,
      OMNIROUTE_DATABASE: path.join(directory, "gateway.sqlite"),
      OMNIROUTE_URL: "http://fixture-gateway.invalid/v1",
      OMNIROUTE_API_KEY: "fixture-private-key",
      OMNIROUTE_MODEL: "auto",
      FREE_ONLY: "true",
      NODE_ENV: "production",
    };
    previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    db = new DatabaseSync(env.OMNIROUTE_DATABASE);
    // Build the fixture atomically; avoid a disk sync for each inserted row.
    db.exec(`
      BEGIN;
      CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
      CREATE TABLE api_keys (
        key TEXT, is_active INTEGER, revoked_at TEXT,
        model_access_mode TEXT, allowed_models TEXT,
        allowed_connections TEXT, allow_auto_combos INTEGER
      );
      CREATE TABLE provider_connections (
        id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER,
        auth_type TEXT, api_key TEXT
      );
      INSERT INTO provider_connections VALUES (
        'fixture-connection', 'fixture-provider', 1,
        'apikey', 'fixture-account-secret'
      );
    `);
    const settings = {
      freeAccessPolicy: "strict",
      hidePaidModels: true,
      excludeTosAvoid: true,
      modelVisibilityAllowlist: [model],
      blockedProviders: ["paid-provider"],
    };
    const insert = db.prepare(
      "INSERT INTO key_value VALUES ('settings', ?, ?)",
    );
    for (const [key, value] of Object.entries(settings))
      insert.run(key, JSON.stringify(value));
    db.prepare(
      "INSERT INTO api_keys VALUES (?, 1, NULL, 'restricted', ?, ?, 0)",
    ).run(
      env.OMNIROUTE_API_KEY,
      JSON.stringify(["auto"]),
      JSON.stringify(["fixture-connection"]),
    );
    db.exec("COMMIT");
    writePolicy(policy());
    routing = new RoutingService(new NovaConfig());
  });

  afterEach(() => {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("accepts a verified free auto route from a real read-only SQLite database", () => {
    expect(routing.assertFree()).toMatchObject({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
      route: "auto",
      enabledModels: [model],
    });
    expect(JSON.stringify(routing.status())).not.toContain(
      "fixture-private-key",
    );
  });

  it("keeps auto ready but rejects explicit dispatch for a legacy auto-only key", () => {
    expect(routing.assertFree()).toMatchObject({
      ready: true,
      enabledModels: [model],
      explicitModels: [],
    });
    expect(() => routing.assertFreeModel(model)).toThrow(
      FreeRoutingBlockedError,
    );
    fs.writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify({
        modelRoles: { code: { preferred: [model], fallback: null } },
      }),
    );
    expect(() => routing.roleModels("code")).toThrow(FreeRoutingBlockedError);
  });

  it("accepts explicit free models only within the credential-bound auto pool", () => {
    writePolicy(boundPolicy());
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(["auto", model]),
    );
    expect(routing.assertFree().ready).toBe(true);
    expect(routing.assertFreeModel(model)).toBe(model);
  });

  it("projects embedding models only from the strictly verified explicit scope", () => {
    const embedding = "fixture-provider/free-embedding";
    const changed = boundPolicy();
    changed.enabledModels.push(embedding);
    changed.nativeModelAllowlist.push(embedding);
    const embeddingCandidate = {
      ...candidate,
      modelId: "free-embedding",
      nativeQuota: { status: "SAFE" },
      modelType: "embedding",
    };
    changed.catalog.push(embeddingCandidate);
    writePolicy(changed);
    db.prepare(
      "UPDATE key_value SET value=? WHERE namespace='settings' AND key='modelVisibilityAllowlist'",
    ).run(JSON.stringify([model, embedding]));
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(["auto", model, embedding]),
    );
    expect(routing.assertFree()).toMatchObject({
      explicitModels: [model, embedding],
      embeddingModels: [embedding],
    });
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(["auto", model]),
    );
    expect(routing.assertFree().embeddingModels).toEqual([]);
    db.prepare(
      "UPDATE key_value SET value='false' WHERE namespace='settings' AND key='hidePaidModels'",
    ).run();
    expect(routing.status()).toMatchObject({
      ready: false,
      explicitModels: [],
      embeddingModels: [],
    });
  });

  it.each([
    ["missing auto", [model]],
    ["duplicate auto", ["auto", "auto"]],
    ["duplicate model", ["auto", model, model]],
    ["unlisted model", ["auto", "fixture-provider/other"]],
    ["combo bypass", ["auto", "custom-combo"]],
  ])("blocks expanded key scope with %s", (_name, models) => {
    writePolicy(boundPolicy());
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(models),
    );
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
    });
  });

  it.each([
    "unbound",
    "unattested",
    "missing allowlist",
    "excluded",
    "paid",
    "local",
    "exhausted",
  ])("blocks explicit scope when its model is %s", (change) => {
    const changed = boundPolicy();
    const row = changed.catalog[0]!;
    if (change === "unbound")
      Object.assign(changed, { verifiedConnections: undefined });
    if (change === "unattested") row.accountFreeVerified = false;
    if (change === "missing allowlist")
      Object.assign(changed, { nativeModelAllowlist: undefined });
    if (change === "excluded") Object.assign(row, { modelExcluded: true });
    if (change === "paid") Object.assign(row, { paid: true });
    if (change === "local") Object.assign(row, { local: true });
    if (change === "exhausted") row.nativeQuota.status = "EXHAUSTED";
    writePolicy(changed);
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(["auto", model]),
    );
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
    });
  });

  it("only permits role-selected models that remain in the verified free policy and saved role list", () => {
    writePolicy(boundPolicy());
    db.prepare("UPDATE api_keys SET allowed_models=?").run(
      JSON.stringify(["auto", model]),
    );
    fs.writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify({
        modelRoles: {
          conversation: { preferred: [model], fallback: null },
        },
      }),
    );
    expect(routing.assertRoleModel("conversation", model)).toBe(model);
    expect(() => routing.assertRoleModel("code", model)).toThrow(
      FreeRoutingBlockedError,
    );
    expect(() => routing.assertRoleModel("conversation", "paid/model")).toThrow(
      FreeRoutingBlockedError,
    );
    const changed = boundPolicy();
    const candidate = changed.catalog[0];
    if (!candidate) throw new Error("Missing model fixture");
    Object.assign(candidate, { paid: true });
    writePolicy(changed);
    expect(() => routing.assertRoleModel("conversation", model)).toThrow(
      FreeRoutingBlockedError,
    );
  });

  it("rejects stale role assignments across chat and embedding model types", () => {
    const embedding = "fixture-provider/free-embedding";
    vi.spyOn(routing, "assertFree").mockReturnValue({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
      explicitModels: [model, embedding],
      embeddingModels: [embedding],
    });
    fs.writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify({
        modelRoles: {
          conversation: { preferred: [embedding], fallback: model },
          code: { preferred: [embedding], fallback: null },
          embedding: { preferred: [model], fallback: embedding },
        },
      }),
    );
    expect(routing.assertRoleModel("conversation", model)).toBe(model);
    expect(routing.assertRoleModel("embedding", embedding)).toBe(embedding);
    expect(() => routing.assertRoleModel("conversation", embedding)).toThrow(
      FreeRoutingBlockedError,
    );
    expect(() => routing.assertRoleModel("embedding", model)).toThrow(
      FreeRoutingBlockedError,
    );
    expect(routing.roleModels("conversation")).toEqual([model]);
    expect(routing.roleModels("code")).toEqual([]);
    expect(routing.roleModels("embedding")).toEqual([embedding]);
    vi.restoreAllMocks();
  });

  it("verifies a bound account without projecting credential material or fingerprints", () => {
    const changed = boundPolicy();
    writePolicy(changed);
    expect(routing.assertFree().ready).toBe(true);
    const projected = JSON.stringify([
      routing.status(),
      routing.verifyForManagement(),
      routing.providerInventory(),
    ]);
    expect(projected).not.toContain(connection.api_key);
    expect(projected).not.toContain(
      changed.verifiedConnections[0]!.fingerprint,
    );
  });

  it.each([
    [
      "credential rotation",
      "UPDATE provider_connections SET api_key='rotated-secret'",
    ],
    [
      "same-provider account replacement",
      "DELETE FROM provider_connections; INSERT INTO provider_connections VALUES ('fixture-connection', 'fixture-provider', 1, 'apikey', 'other-account-secret')",
    ],
    [
      "authentication type",
      "UPDATE provider_connections SET auth_type='oauth'",
    ],
    [
      "provider reassignment",
      "UPDATE provider_connections SET provider='other-provider'",
    ],
  ])("blocks a bound account after %s drift", (_name, mutation) => {
    const changed = boundPolicy();
    // Reassignment must also fail when the new provider is independently verified.
    changed.verifiedProviders.push("other-provider");
    writePolicy(changed);
    expect(routing.assertFree().ready).toBe(true);
    db.exec(mutation);
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
      status: "POLICY_DRIFT_BLOCKED",
    });
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
  });

  it.each([
    "missing",
    "duplicate",
    "invalid fingerprint",
    "wrong fingerprint",
    "wrong provider",
    "extra connection",
    "non-array",
    "null binding",
  ])("fails closed with a %s binding proof", (change) => {
    const changed = boundPolicy();
    const binding = changed.verifiedConnections[0]!;
    if (change === "missing") changed.verifiedConnections = [];
    if (change === "duplicate")
      changed.verifiedConnections.push({ ...binding });
    if (change === "invalid fingerprint") binding.fingerprint = "invalid";
    if (change === "wrong fingerprint") binding.fingerprint = "0".repeat(64);
    if (change === "wrong provider") binding.provider = "other-provider";
    if (change === "extra connection")
      changed.verifiedConnections.push({ ...binding, id: "extra-connection" });
    if (change === "non-array")
      Object.assign(changed, { verifiedConnections: {} });
    if (change === "null binding")
      Object.assign(changed, { verifiedConnections: [null] });
    writePolicy(changed);
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
      status: "POLICY_DRIFT_BLOCKED",
    });
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
  });

  it("keeps legacy policies usable without credential columns", () => {
    db.exec(`
      BEGIN;
      ALTER TABLE provider_connections DROP COLUMN auth_type;
      ALTER TABLE provider_connections DROP COLUMN api_key;
      COMMIT;
    `);
    expect(routing.assertFree().ready).toBe(true);
    writePolicy(boundPolicy());
    expect(routing.status()).toMatchObject({
      ready: false,
      status: "POLICY_UNAVAILABLE",
    });
  });

  it("keeps a pending management change blocked across service instances", () => {
    expect(routing.assertFree().ready).toBe(true);
    fs.writeFileSync(
      path.join(directory, "free-routing-management-block.json"),
      JSON.stringify({ pending: true }),
    );
    for (const service of [routing, new RoutingService(new NovaConfig())]) {
      expect(service.status()).toMatchObject({
        ready: false,
        policyVerified: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => service.assertFree()).toThrow(FreeRoutingBlockedError);
    }
  });

  it.each(["malformed", "dangling symlink", "directory"])(
    "blocks any existing management marker, including a %s",
    (kind) => {
      const marker = path.join(directory, "free-routing-management-block.json");
      if (kind === "dangling symlink")
        fs.symlinkSync(path.join(directory, "missing-marker-target"), marker);
      else if (kind === "directory") fs.mkdirSync(marker);
      else fs.writeFileSync(marker, "not-json");
      expect(routing.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    },
  );

  it("allows management verification without authorizing inference or removing its marker", () => {
    const marker = path.join(directory, "free-routing-management-block.json");
    fs.writeFileSync(marker, "{}");
    expect(routing.verifyForManagement()).toMatchObject({
      ready: true,
      policyVerified: true,
    });
    expect(fs.existsSync(marker)).toBe(true);
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    db.exec("UPDATE provider_connections SET is_active=0");
    expect(routing.verifyForManagement()).toMatchObject({
      ready: false,
      policyVerified: false,
    });
  });

  it("checks a management marker before the test-only unrestricted bypass", () => {
    process.env.FREE_ONLY = "false";
    process.env.NODE_ENV = "test";
    const service = new RoutingService(new NovaConfig());
    expect(service.status().ready).toBe(true);
    fs.writeFileSync(
      path.join(directory, "free-routing-management-block.json"),
      "{}",
    );
    expect(service.status()).toMatchObject({
      ready: false,
      status: "POLICY_CHANGE_PENDING",
    });
    expect(() => service.assertFree()).toThrow(FreeRoutingBlockedError);
    db.exec("UPDATE api_keys SET revoked_at='2026-10-10T12:00:00Z'");
    expect(service.verifyForManagement().ready).toBe(false);
  });

  it("fails closed when the management marker cannot be inspected", () => {
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("private filesystem failure"), {
        code: "EACCES",
      });
    });
    try {
      const status = routing.status();
      expect(status).toMatchObject({
        ready: false,
        policyVerified: false,
        status: "POLICY_UNAVAILABLE",
      });
      expect(JSON.stringify(status)).not.toContain(
        "private filesystem failure",
      );
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    } finally {
      stat.mockRestore();
    }
  });

  it.each([
    [
      "native free policy",
      "UPDATE key_value SET value='\"permissive\"' WHERE key='freeAccessPolicy'",
    ],
    [
      "paid-model visibility",
      "UPDATE key_value SET value='false' WHERE key='hidePaidModels'",
    ],
    [
      "native model allowlist",
      "UPDATE key_value SET value='[]' WHERE key='modelVisibilityAllowlist'",
    ],
    [
      "key model restriction",
      'UPDATE api_keys SET allowed_models=\'["auto","paid-model"]\'',
    ],
    [
      "key connection restriction",
      "UPDATE api_keys SET allowed_connections='[\"unverified-connection\"]'",
    ],
    ["key revocation", "UPDATE api_keys SET revoked_at='2026-10-10T12:00:00Z'"],
    [
      "deleted verified connection",
      "DELETE FROM provider_connections WHERE id='fixture-connection'",
    ],
    [
      "reassigned verified connection",
      "UPDATE provider_connections SET provider='paid-provider' WHERE id='fixture-connection'",
    ],
    [
      "inactive verified connection",
      "UPDATE provider_connections SET is_active=0 WHERE id='fixture-connection'",
    ],
  ])(
    "blocks inference after %s drift, without a restart",
    (_name, mutation) => {
      expect(routing.assertFree().ready).toBe(true);
      db.exec(mutation);
      expect(routing.status()).toMatchObject({
        ready: false,
        policyVerified: false,
        status: "POLICY_DRIFT_BLOCKED",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    },
  );

  it("requires every allowed connection to exist, even if its ID remains locally verified", () => {
    const changed = policy();
    changed.verifiedConnectionIds.push("missing-connection");
    writePolicy(changed);
    db.prepare("UPDATE api_keys SET allowed_connections=?").run(
      JSON.stringify(changed.verifiedConnectionIds),
    );
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
      status: "POLICY_DRIFT_BLOCKED",
    });
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
  });

  it("fails closed when the native connection inventory is unavailable", () => {
    expect(routing.assertFree().ready).toBe(true);
    db.exec("DROP TABLE provider_connections");
    expect(routing.status()).toMatchObject({
      ready: false,
      policyVerified: false,
      status: "POLICY_UNAVAILABLE",
    });
    expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
  });

  it.each(["paid", "ineligible", "exhausted"])(
    "blocks inference when the verified model becomes %s",
    (change) => {
      expect(routing.assertFree().ready).toBe(true);
      const changed = policy();
      const modelCandidate = changed.catalog[0];
      if (!modelCandidate) throw new Error("Missing model fixture");
      if (change === "paid") Object.assign(modelCandidate, { paid: true });
      if (change === "ineligible") modelCandidate.nativeAutoEligible = false;
      if (change === "exhausted")
        modelCandidate.nativeQuota.status = "EXHAUSTED";
      writePolicy(changed);
      expect(routing.status()).toMatchObject({
        ready: false,
        policyVerified: true,
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
    },
  );
});

describe("OmniRouteManagement", () => {
  let management: OmniRouteManagement;
  beforeEach(() => {
    management = new OmniRouteManagement(new NovaConfig());
  });

  it("keeps its session private, shares a concurrent login and retries an expired session once", async () => {
    let logins = 0;
    let reads = 0;
    management.configure({
      password: "fixture-password",
      scope: "nova-owner",
      fetcher: async (url, options) => {
        const target = String(url);
        const headers = (options?.headers ?? {}) as Record<string, string>;
        if (target.endsWith("/auth/login")) {
          logins++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(JSON.parse(String(options?.body)).password).toBe(
            "fixture-password",
          );
          return new Response("{}", {
            headers: {
              "set-cookie": "auth_token=fixture-cookie; HttpOnly; Path=/",
            },
          });
        }
        expect(headers.cookie).toBe("auth_token=fixture-cookie");
        reads++;
        return new Response("{}", { status: reads === 1 ? 401 : 200 });
      },
    });
    await Promise.all([management.login(), management.login()]);
    expect(logins).toBe(1);
    await management.request("/api/memory");
    expect(logins).toBe(2);
    expect(reads).toBe(2);
    await expect(
      management.request("https://example.invalid/api/keys"),
    ).rejects.toThrow(/Invalid/);
    await expect(management.skills("../etc")).rejects.toThrow(/Invalid skill/);
  });

  it("a failing management API can not report readiness or leak what it answered", async () => {
    management.configure({
      password: "fixture-password",
      fetcher: async () => new Response("private-error", { status: 401 }),
    });
    const status = await management.status();
    expect(status.online).toBe(false);
    expect(JSON.stringify(status)).not.toContain("fixture-password");
    expect(JSON.stringify(status)).not.toContain("private-error");
  });

  it("without a password it is simply not configured", async () => {
    expect(new OmniRouteManagement(new NovaConfig()).configured).toBe(false);
    expect(
      await new OmniRouteManagement(new NovaConfig()).status(),
    ).toMatchObject({ configured: false, online: false });
  });
});
