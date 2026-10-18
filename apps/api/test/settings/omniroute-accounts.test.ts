import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { OmniRouteAccountsController } from "../../src/settings/omniroute-accounts.controller.js";

const gateway = "http://verified-gateway.invalid/v1";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
const ERROR =
  "OmniRoute-accounts zijn niet beschikbaar. Controleer de koppeling.";
const connection = {
  id: "connection-1",
  provider: "provider-1",
  name: "Account",
  isActive: true,
  apiKey: "private-api-key",
  accessToken: "private-access-token",
  providerSpecificData: { cookie: "private-cookie" },
};
const model = {
  provider: "provider-1",
  modelId: "vendor/model:free",
  displayName: "Free candidate",
  freeType: "recurring",
  monthlyTokens: 123,
  creditTokens: 0,
  tos: "private-tos",
  poolKey: "private-pool",
};
const combo = {
  id: "balanced",
  name: "balanced-route",
  displayName: "Balanced route",
  isActive: true,
  strategy: "priority",
  models: [
    "provider-1/vendor/model:free",
    { provider: "provider-2", modelId: "second/model" },
  ],
  system_message: "private-prompt",
  apiKey: "private-combo-secret",
};

function fixture({ verified = true, configured = true } = {}) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-omniroute-inventory-"),
  );
  const database = path.join(dir, "omniroute.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE api_keys(id TEXT PRIMARY KEY,key TEXT)");
  db.prepare("INSERT INTO api_keys VALUES(?,?)").run("key-1", "nova-secret");
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const management = {
    configured,
    request: vi.fn(async (endpoint: string): Promise<unknown> => {
      if (endpoint === "/api/free-models") return { models: [model] };
      if (endpoint.startsWith("/api/combos"))
        return { combos: [combo], total: 1 };
      return { connections: [connection], total: 1 };
    }),
  };
  const controller = new OmniRouteAccountsController(
    {
      omniUrl: gateway,
      verifiedOmniUrl: verified ? gateway : "http://changed.invalid/v1",
      omniDatabase: database,
      omniKey: "nova-secret",
    } as NovaConfig,
    management as unknown as OmniRouteManagement,
  );
  return { controller, management };
}

function expectUnavailable(result: unknown) {
  expect(result).toEqual({
    available: false,
    error: ERROR,
    truncated: false,
    connections: [],
    models: [],
    combos: [],
    billingVerified: false,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain(gateway);
}

describe("private OmniRoute account inventory", () => {
  it("projects only explicit hidden-model metadata and documents catalog-only effect", async () => {
    const { controller, management } = fixture();
    management.request.mockResolvedValue({
      models: [{ provider: "private-provider-model", apiKey: "private" }],
      hiddenModelsByProvider: {
        provider: ["vendor/model-a", "vendor/model-b", "../../invalid"],
        "../invalid": ["hidden"],
      },
      modelCompatOverrides: { private: "metadata" },
    });
    const result = await controller.modelVisibility();
    expect(result).toEqual({
      available: true,
      truncated: false,
      hidden: [
        { provider: "provider", modelId: "vendor/model-a" },
        { provider: "provider", modelId: "vendor/model-b" },
      ],
    });
    expect(management.request).toHaveBeenCalledWith("/api/provider-models");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("requests only fixed account and catalog metadata endpoints and projects no secrets", async () => {
    const { controller, management } = fixture();
    const result = await controller.report();
    expect(result).toEqual({
      available: true,
      truncated: false,
      connections: [
        {
          id: "connection-1",
          provider: "provider-1",
          name: "Account",
          active: true,
          credentialPresent: true,
        },
      ],
      models: [
        {
          provider: "provider-1",
          modelId: "vendor/model:free",
          name: "Free candidate",
          freeType: "recurring",
          monthlyTokens: 123,
          creditTokens: 0,
        },
      ],
      combos: [
        {
          id: "balanced",
          name: "balanced-route",
          displayName: "Balanced route",
          active: true,
          strategy: "priority",
          models: ["provider-1/vendor/model:free", "provider-2/second/model"],
        },
      ],
      billingVerified: false,
    });
    expect(management.request.mock.calls).toEqual([
      ["/api/providers?limit=200&offset=0"],
      ["/api/free-models"],
      ["/api/combos?limit=200&offset=0"],
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("projects only bounded API-key rights and never forwards masked or raw key values", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/keys"
        ? {
            total: 1,
            allowKeyReveal: true,
            keys: [
              {
                id: "key-1",
                name: "NOVA local key",
                isActive: true,
                modelAccessMode: "restricted",
                allowedModels: ["auto"],
                allowedCombos: [],
                allowedConnections: ["connection-1"],
                expiresAt: "2026-12-01T00:00:00Z",
                key: "sk-secret-raw",
                maskedKey: "sk-••••secret",
              },
            ],
          }
        : {},
    );
    const result = await controller.apiKeys();
    expect(result).toEqual({
      available: true,
      truncated: false,
      keys: [
        {
          id: "key-1",
          name: "NOVA local key",
          active: true,
          isNovaKey: true,
          accessMode: "restricted",
          allowedModelCount: 1,
          allowedComboCount: 0,
          allowedConnectionCount: 1,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
    expect(management.request).toHaveBeenCalledWith("/api/keys");
    expect(JSON.stringify(result)).not.toMatch(
      /secret|masked|key-raw|allowKeyReveal/,
    );
  });

  it("shows bounded cached quotas for live accounts only without refreshing", async () => {
    const { controller, management } = fixture();
    const fetchedAt = new Date().toISOString();
    management.request.mockImplementation(async (endpoint) => {
      if (endpoint === "/api/providers?limit=200&offset=0")
        return { connections: [connection], total: 1 };
      if (endpoint === "/api/usage/provider-limits")
        return {
          intervalMinutes: 70,
          lastAutoSyncAt: fetchedAt,
          caches: {
            "connection-1": {
              fetchedAt,
              source: "private-source",
              message: "private provider response",
              plan: "private-plan",
              billing: { secret: "private-billing" },
              quotas: {
                daily: {
                  limit: 1000,
                  remaining: 750,
                  remainingPercentage: 75,
                  resetAt: fetchedAt,
                  unlimited: false,
                  token: "private-quota-token",
                },
              },
            },
            "deleted-connection": {
              fetchedAt,
              quotas: { daily: { remaining: 10 } },
            },
          },
        };
      return {};
    });
    const result = await controller.usage();
    expect(result).toEqual({
      available: true,
      truncated: false,
      intervalMinutes: 70,
      lastAutoSyncAt: fetchedAt,
      billingVerified: false,
      connections: [
        {
          id: "connection-1",
          provider: "provider-1",
          name: "Account",
          fetchedAt,
          stale: false,
          quotas: [
            {
              window: "daily",
              limit: 1000,
              remaining: 750,
              remainingPercentage: 75,
              resetAt: fetchedAt,
              unlimited: false,
            },
          ],
        },
      ],
    });
    expect(management.request.mock.calls).toEqual([
      ["/api/providers?limit=200&offset=0"],
      ["/api/usage/provider-limits"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private|deleted-connection|quota-token|private-billing/,
    );
  });

  it("marks cached usage truncated when the provider page exceeds its bound without a total", async () => {
    const { controller, management } = fixture();
    const fetchedAt = new Date().toISOString();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/providers?limit=200&offset=0"
        ? {
            connections: Array.from({ length: 201 }, (_, index) => ({
              ...connection,
              id: `connection-${index}`,
            })),
          }
        : {
            intervalMinutes: 70,
            caches: {
              "connection-200": {
                fetchedAt,
                quotas: { daily: { remaining: 5 } },
              },
            },
          },
    );

    const result = await controller.usage();

    expect(result.truncated).toBe(true);
    expect(result.connections).toEqual([]);
  });

  it("fails closed and hides upstream details when cached usage shape is invalid", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/providers?limit=200&offset=0"
        ? { connections: [connection], total: 1 }
        : { caches: "private-invalid-response", secret: "private" },
    );
    const result = await controller.usage();
    expect(result).toMatchObject({
      available: false,
      connections: [],
      billingVerified: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    { verified: false, configured: true },
    { verified: true, configured: false },
    { verified: false, configured: false },
  ])(
    "checks provenance and management before any request: %j",
    async (options) => {
      const { controller, management } = fixture(options);
      expectUnavailable(await controller.report());
      expect(management.request).not.toHaveBeenCalled();
    },
  );

  it("caps each source and reports pagination without reading more endpoints", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/free-models"
        ? { models: Array.from({ length: 501 }, () => model) }
        : endpoint.startsWith("/api/combos")
          ? { combos: Array.from({ length: 201 }, () => combo), total: 999 }
          : {
              connections: Array.from({ length: 201 }, () => connection),
              total: 999,
            },
    );
    const result = await controller.report();
    expect(result.truncated).toBe(true);
    expect(result.connections).toHaveLength(200);
    expect(result.models).toHaveLength(500);
    expect(result.combos).toHaveLength(200);
    expect(management.request).toHaveBeenCalledTimes(3);
  });

  it("reports a bounded upstream page as truncated when total exceeds the limit", async () => {
    const { controller, management } = fixture();
    management.request.mockResolvedValueOnce({
      connections: [connection],
      total: 201,
    });
    expect((await controller.report()).truncated).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { connections: {} },
    { connections: "private-invalid" },
  ])("rejects malformed account arrays: %j", async (value) => {
    const { controller, management } = fixture();
    management.request.mockResolvedValueOnce(value);
    expectUnavailable(await controller.report());
  });

  it.each([null, [], {}, { models: {} }, { models: "private-invalid" }])(
    "rejects malformed catalog arrays: %j",
    async (value) => {
      const { controller, management } = fixture();
      management.request.mockImplementation(async (endpoint) =>
        endpoint === "/api/free-models" ? value : { connections: [] },
      );
      expectUnavailable(await controller.report());
    },
  );

  it.each([null, [], {}, { combos: {} }, { combos: "private-invalid" }])(
    "rejects malformed combo arrays: %j",
    async (value) => {
      const { controller, management } = fixture();
      management.request.mockImplementation(async (endpoint) =>
        endpoint === "/api/free-models"
          ? { models: [model] }
          : endpoint.startsWith("/api/combos")
            ? value
            : { connections: [connection], total: 1 },
      );
      expectUnavailable(await controller.report());
    },
  );

  it("filters invalid identifiers and malformed rows", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/free-models"
        ? {
            models: [
              model,
              null,
              [],
              { ...model, provider: "bad/provider" },
              { ...model, modelId: "bad?model" },
              { ...model, modelId: "x".repeat(201) },
            ],
          }
        : endpoint.startsWith("/api/combos")
          ? { combos: [combo] }
          : {
              connections: [
                connection,
                null,
                [],
                { ...connection, id: "../bad" },
                { ...connection, provider: "bad provider" },
                { ...connection, id: "x".repeat(101) },
              ],
            },
    );
    const result = await controller.report();
    expect(result.connections).toHaveLength(1);
    expect(result.models).toHaveLength(1);
  });

  it("sanitizes and bounds labels without including extra fields", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/free-models"
        ? {
            models: [
              {
                ...model,
                displayName: "Bearer private-name " + "x".repeat(250),
                freeType: "password=private-type " + "x".repeat(80),
              },
            ],
          }
        : endpoint.startsWith("/api/combos")
          ? { combos: [combo] }
          : {
              connections: [
                {
                  ...connection,
                  name: "accessToken=private-label " + "x".repeat(250),
                },
              ],
            },
    );
    const result = await controller.report();
    expect(result.connections[0]!.name).toHaveLength(200);
    expect(result.models[0]!.name).toHaveLength(200);
    expect(result.models[0]!.freeType).toHaveLength(60);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "123",
    null,
    {},
  ])("does not claim invalid token budgets: %j", async (value) => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint === "/api/free-models"
        ? { models: [{ ...model, monthlyTokens: value, creditTokens: value }] }
        : endpoint.startsWith("/api/combos")
          ? { combos: [] }
          : { connections: [] },
    );
    expect((await controller.report()).models[0]).toMatchObject({
      monthlyTokens: null,
      creditTokens: null,
    });
  });

  it("projects only boolean activation and nonempty string credential presence", async () => {
    const { controller, management } = fixture();
    management.request.mockResolvedValueOnce({
      connections: [
        { ...connection, isActive: false, apiKey: "", accessToken: " " },
        { ...connection, isActive: 1, apiKey: {}, accessToken: undefined },
        {
          ...connection,
          isActive: "true",
          apiKey: null,
          accessToken: "opaque",
        },
      ],
    });
    expect(
      (await controller.report()).connections.map(
        ({ active, credentialPresent }) => ({ active, credentialPresent }),
      ),
    ).toEqual([
      { active: false, credentialPresent: false },
      { active: null, credentialPresent: false },
      { active: null, credentialPresent: true },
    ]);
  });

  it.each([
    "/api/providers?limit=200&offset=0",
    "/api/free-models",
    "/api/combos?limit=200&offset=0",
  ])("hides raw upstream failures from %s", async (failedEndpoint) => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) => {
      if (endpoint === failedEndpoint)
        throw new Error(`private-secret ${gateway}`);
      return endpoint === "/api/free-models"
        ? { models: [] }
        : endpoint.startsWith("/api/combos")
          ? { combos: [] }
          : { connections: [] };
    });
    expectUnavailable(await controller.report());
  });
});
