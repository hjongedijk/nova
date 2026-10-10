import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
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
        id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER
      );
      INSERT INTO provider_connections VALUES (
        'fixture-connection', 'fixture-provider', 1
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
