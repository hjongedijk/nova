import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiMaintenanceService } from "../../src/apis/api-maintenance.service.js";
import type { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import {
  OPENAPI3,
  SECRET,
  petShop,
  startFakeApi,
  type FakeApi,
} from "./fake-api.js";
import { makeEngine } from "./helpers.js";

let api: FakeApi;
let env: ReturnType<typeof makeEngine>;
let state: JarvisStateStore;
let maintenance: ApiMaintenanceService;

const due = () => {
  const i = env.registry.get("pets")!;
  i.maintenance.nextDueAt = 0;
  env.registry.save(i);
};

beforeEach(async () => {
  env = makeEngine();
  state = new JarvisStateStore(env.config, {
    publish: () => undefined,
  } as unknown as MqttService);
  state.data.alerts = [];
  state.data.active = {};
  maintenance = new ApiMaintenanceService(env.engine, state);
  api = await startFakeApi(petShop);
  await env.engine.connect({
    baseUrl: api.url,
    token: SECRET,
    name: "Pets",
    local: true,
  });
});
afterEach(async () => api.close());

describe("maintenance", () => {
  it("a healthy daily probe schedules the next one durably", async () => {
    due();
    const [round] = await maintenance.tick(1_000_000);
    expect(round).toMatchObject({ id: "pets", outcome: "healthy" });
    env.registry.reload();
    expect(env.registry.get("pets")!.maintenance.nextDueAt).toBe(
      1_000_000 + 86_400_000,
    );
    // not due again yet
    expect(await maintenance.tick(1_000_000 + 1000)).toEqual([]);
    expect(env.registry.get("pets")!.lastTest).toMatchObject({
      ok: true,
      operation: "listPets",
    });
  });

  it("only ever sends read-only probes", async () => {
    due();
    api.hits.length = 0;
    await maintenance.tick();
    expect(api.hits.map((h) => h.method)).toEqual(["GET"]);
    expect(api.hits[0]!.url).toBe("/v1/pets");
  });

  it("401 means expired credentials: alert with a plain next step, operations degraded, nothing rotated", async () => {
    const ref = (env.registry.get("pets")!.auth as { ref: string }).ref;
    api.handle(() => ({ status: 401, body: { error: "expired" } }));
    due();
    const [round] = await maintenance.tick();
    expect(round).toMatchObject({
      outcome: "credentials_rejected",
      detail: "HTTP 401",
    });
    const integration = env.registry.get("pets")!;
    expect(integration.status).toBe("credentials_expired");
    expect(
      integration.operations
        .filter((o) => o.enabled)
        .every((o) => o.status === "degraded"),
    ).toBe(true);
    expect(state.data.alerts).toHaveLength(1);
    expect(state.data.alerts[0]).toMatchObject({
      key: "api:pets:auth",
      severity: "warning",
    });
    expect(state.data.alerts[0]!.detail).toMatch(/nieuw token/);
    expect(state.data.alerts[0]!.detail).toMatch(/nooit een sleutel/);
    expect(JSON.stringify(state.data.alerts)).not.toContain(SECRET);
    expect(env.vault.get(ref)).toBe(SECRET);
    // a second failing check does not repeat the alert
    due();
    await maintenance.tick();
    expect(state.data.alerts).toHaveLength(1);
    // the user fixes the credential: back to normal, operations restored, alert closed
    api.handle(petShop);
    due();
    expect((await maintenance.tick())[0]!.outcome).toBe("healthy");
    expect(env.registry.get("pets")!.status).toBe("ready");
    expect(
      env.registry
        .get("pets")!
        .operations.every((o) => o.status !== "degraded"),
    ).toBe(true);
    expect(state.data.active["api:pets:auth"]).toBeUndefined();
  });

  it("a streak of 5xx marks the probe operation degraded and alerts only after three failures", async () => {
    api.handle(() => ({ status: 503, body: {} }));
    for (let n = 1; n <= 3; n++) {
      due();
      const [round] = await maintenance.tick();
      expect(round!.outcome).toBe("failing");
      expect(state.data.alerts.length, `after ${n}`).toBe(n < 3 ? 0 : 1);
    }
    const integration = env.registry.get("pets")!;
    expect(integration.status).toBe("degraded");
    expect(
      integration.operations.find((o) => o.id === "listPets")!.status,
    ).toBe("degraded");
    expect(integration.operations.find((o) => o.id === "getPet")!.status).toBe(
      "ok",
    );
    // failing checks are retried within the hour, not the day
    expect(integration.maintenance.nextDueAt - Date.now()).toBeLessThan(
      3_700_000,
    );
  });

  it("410 on the probe is reported at once", async () => {
    api.handle(() => ({ status: 410, body: {} }));
    due();
    await maintenance.tick();
    expect(state.data.alerts[0]).toMatchObject({ key: "api:pets:down" });
  });

  it("an unreachable host ends as 'unreachable'", async () => {
    await api.close();
    for (let n = 0; n < 3; n++) {
      due();
      await maintenance.tick();
    }
    expect(env.registry.get("pets")!.status).toBe("unreachable");
    api = await startFakeApi(petShop);
  });

  it("weekly re-discovery raises a drift alert through maintenance", async () => {
    const next = structuredClone(OPENAPI3) as unknown as {
      paths: Record<string, Record<string, unknown>>;
    };
    delete next.paths["/pets/search"];
    api.handle((hit) =>
      hit.url === "/openapi.json" ? { body: next } : petShop(hit),
    );
    const i = env.registry.get("pets")!;
    i.maintenance.nextDueAt = 0;
    i.maintenance.nextDiscoveryAt = 0;
    env.registry.save(i);
    const [round] = await maintenance.tick();
    expect(round!.alerts).toEqual(["api:pets:drift"]);
    expect(state.data.alerts[0]!.detail).toMatch(/verdwenen: 1/);
  });

  it("a failed re-discovery never wipes the learned spec", async () => {
    api.handle((hit) =>
      hit.url.startsWith("/v1/") ? petShop(hit) : { status: 404, body: {} },
    );
    const before = env.registry.get("pets")!.operations.length;
    const result = await env.engine.refresh("pets");
    expect(result.available).toBe(false);
    expect(env.registry.get("pets")!.operations).toHaveLength(before);
  });

  it("self-heals a moved read path from a same-host redirect, but not a mutating one", async () => {
    api.handle((hit) => {
      if (hit.url === "/v1/pets")
        return { status: 301, headers: { location: "/v1/animals" }, body: "" };
      if (hit.url === "/v1/animals")
        return hit.headers.authorization === `Bearer ${SECRET}`
          ? { body: [{ id: "9" }] }
          : { status: 401, body: {} };
      return petShop(hit);
    });
    const result = await env.engine.call("pets", "listPets", {});
    expect(result.ok).toBe(true);
    const op = env.registry
      .get("pets")!
      .operations.find((o) => o.id === "listPets")!;
    expect(op.path).toBe("/animals");
    expect(op.hints.join(" ")).toMatch(/moved from \/pets to \/animals/);
    const create = await env.engine.call("pets", "createPet", {
      body: { name: "x" },
    });
    expect(create.status).toBe(301);
    expect(
      env.registry.get("pets")!.operations.find((o) => o.id === "createPet")!
        .path,
    ).toBe("/pets");
  });
});

describe("OAuth2 client credentials", () => {
  it("fetches and caches a token from the same host, and never sends the client secret anywhere else", async () => {
    let tokenCalls = 0;
    const other = await startFakeApi(() => ({ body: {} }));
    const oauth = await startFakeApi((hit) => {
      if (hit.url === "/openapi.json")
        return {
          body: {
            openapi: "3.0.0",
            info: { title: "O" },
            components: {
              securitySchemes: {
                oauth: {
                  type: "oauth2",
                  flows: {
                    clientCredentials: {
                      tokenUrl: "/oauth/token",
                      scopes: { read: "r" },
                    },
                  },
                },
              },
            },
            paths: { "/me": { get: { operationId: "me" } } },
          },
        };
      if (hit.url === "/oauth/token") {
        tokenCalls++;
        return hit.headers.authorization ===
          `Basic ${Buffer.from("cid:csecret-0000").toString("base64")}` &&
          hit.body.includes("grant_type=client_credentials")
          ? { body: { access_token: "tok-test-abcdef", expires_in: 3600 } }
          : { status: 401, body: {} };
      }
      if (hit.url === "/me")
        return hit.headers.authorization === "Bearer tok-test-abcdef"
          ? { body: { me: 1 } }
          : { status: 401, body: {} };
      return undefined;
    });
    try {
      const { integration, verified } = await env.engine.connect({
        baseUrl: oauth.url,
        token: JSON.stringify({
          clientId: "cid",
          clientSecret: "csecret-0000",
        }),
        authType: "oauth2_client_credentials",
        tokenUrl: `${oauth.url}/oauth/token`,
        local: true,
        name: "O",
      });
      expect(verified).toBe(true);
      expect(integration.auth.type).toBe("oauth2_client_credentials");
      await env.engine.call("o", "me", {});
      expect(tokenCalls).toBe(1);
      expect(other.hits).toHaveLength(0);
      // A token URL on another host is refused at use time.
      const i = env.registry.get("o")!;
      i.auth = {
        ...(i.auth as {
          type: "oauth2_client_credentials";
          ref: string;
          tokenUrl: string;
        }),
        tokenUrl: `${other.url}/steal`,
      };
      const { forgetTokens } = await import("../../src/apis/auth.js");
      forgetTokens("o");
      const failed = await env.engine.call("o", "me", {});
      expect(failed.ok).toBe(false);
      expect(other.hits).toHaveLength(0);
      expect(JSON.stringify(failed)).not.toContain("csecret-0000");
    } finally {
      await oauth.close();
      await other.close();
    }
  });
});
