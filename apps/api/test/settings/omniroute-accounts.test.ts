import { describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { OmniRouteAccountsController } from "../../src/settings/omniroute-accounts.controller.js";
import { createApp } from "./helpers.js";

const gateway = "http://verified-gateway.invalid/v1";
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

function fixture({ verified = true, configured = true } = {}) {
  const management = {
    configured,
    request: vi.fn(async (endpoint: string): Promise<unknown> =>
      endpoint === "/api/free-models"
        ? { models: [model] }
        : { connections: [connection], total: 1 },
    ),
  };
  const controller = new OmniRouteAccountsController(
    {
      omniUrl: gateway,
      verifiedOmniUrl: verified ? gateway : "http://changed.invalid/v1",
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
    billingVerified: false,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain(gateway);
}

describe("private OmniRoute account inventory", () => {
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
      billingVerified: false,
    });
    expect(management.request.mock.calls).toEqual([
      ["/api/providers?limit=200&offset=0"],
      ["/api/free-models"],
    ]);
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
        : {
            connections: Array.from({ length: 201 }, () => connection),
            total: 999,
          },
    );
    const result = await controller.report();
    expect(result.truncated).toBe(true);
    expect(result.connections).toHaveLength(200);
    expect(result.models).toHaveLength(500);
    expect(management.request).toHaveBeenCalledTimes(2);
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

  it.each(["/api/providers?limit=200&offset=0", "/api/free-models"])(
    "hides raw upstream failures from %s",
    async (failedEndpoint) => {
      const { controller, management } = fixture();
      management.request.mockImplementation(async (endpoint) => {
        if (endpoint === failedEndpoint)
          throw new Error(`private-secret ${gateway}`);
        return endpoint === "/api/free-models"
          ? { models: [] }
          : { connections: [] };
      });
      expectUnavailable(await controller.report());
    },
  );
});

describe("OmniRoute account inventory API guard", () => {
  it("requires the PIN before management and keeps account metadata out of public settings", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const management = nova.app.get(OmniRouteManagement);
    const configured = vi
      .spyOn(management, "configured", "get")
      .mockReturnValue(true);
    const request = vi
      .spyOn(management, "request")
      .mockImplementation(
        async (endpoint) =>
          (endpoint === "/api/free-models"
            ? { models: [model] }
            : { connections: [connection], total: 1 }) as never,
      );
    try {
      const route = "/api/settings/omniroute/accounts";
      expect((await nova.api.get(route)).status).toBe(401);
      expect(
        (await nova.api.get(route).set("x-nova-pin", "wrong")).status,
      ).toBe(401);
      expect(request).not.toHaveBeenCalled();
      const result = await nova.api.get(route).set("x-nova-pin", "4321");
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        available: true,
        billingVerified: false,
      });
      expect(JSON.stringify(result.body)).not.toContain("private");
      request.mockClear();
      const publicSettings = await nova.api.get("/api/settings/public");
      expect(publicSettings.status).toBe(200);
      expect(JSON.stringify(publicSettings.body)).not.toContain("connection-1");
      expect(JSON.stringify(publicSettings.body)).not.toContain("provider-1");
      expect(request).not.toHaveBeenCalled();
    } finally {
      configured.mockRestore();
      request.mockRestore();
      await nova.app.close();
    }
  });
});
