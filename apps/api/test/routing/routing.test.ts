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

  it("the test bypass exists only under NODE_ENV=test, never in production", () => {
    process.env.FREE_ONLY = "false";
    process.env.NODE_ENV = "production";
    expect(new RoutingService(new NovaConfig()).status().ready).toBe(false);
    process.env.NODE_ENV = "test";
    expect(new RoutingService(new NovaConfig()).status().ready).toBe(true);
  });
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
