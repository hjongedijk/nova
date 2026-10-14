import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { RoutingService } from "../../src/routing/routing.service.js";

const primary = "gemini/free-fixture";
const backup = "cloudflare/free-fixture";
const messages = [{ role: "user" as const, content: "Synthetic question." }];
const options = {
  roleModel: { role: "conversation" as const, modelId: primary },
};
const answer = (model: string) =>
  Response.json({
    model,
    choices: [
      {
        message: { role: "assistant", content: "Complete." },
        finish_reason: "stop",
      },
    ],
  });
function setup() {
  const config = {
    omniUrl: "http://gateway.test/v1",
    omniKey: "fixture-key",
    omniModel: "auto",
    omniCompression: "off",
  };
  const routing = {
    assertFree: vi.fn(),
    roleModels: vi.fn(() => [primary, backup]),
    assertRoleModel: vi.fn((_role: string, id: string) => id),
  };
  const client = new OmniRouteClient(
    config as NovaConfig,
    routing as unknown as RoutingService,
  );
  return { config, routing, client };
}
const modelOf = (init?: RequestInit) =>
  JSON.parse(String(init?.body)).model as string;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded model cooldown through verified role routing", () => {
  it("skips a rate-limited model on later requests and probes again after the deadline", async () => {
    let now = 1_000_000,
      recovered = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = setup();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const model = modelOf(init);
        seen.push(model);
        return model === primary && !recovered
          ? new Response(null, {
              status: 429,
              headers: { "retry-after": "120" },
            })
          : answer(model);
      }),
    );
    await client.call(messages, options);
    await client.call(messages, options);
    now += 60_000;
    await client.call(messages, options);
    expect(seen).toEqual([primary, backup, backup, backup]);
    recovered = true;
    now += 60_000;
    expect((await client.call(messages, options)).model).toBe(primary);
    expect((await client.call(messages, options)).model).toBe(primary);
    expect(seen.slice(-2)).toEqual([primary, primary]);
  });

  it("fails fast with 503 when all configured choices are cooling, while rechecking policy", async () => {
    const { client, routing } = setup();
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client.call(messages, options)).rejects.toThrow(
      "OmniRoute request failed (503)",
    );
    await expect(client.call(messages, options)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(routing.assertFree).toHaveBeenCalledTimes(2);
  });

  it("allows one recovery probe while concurrent callers use the verified backup", async () => {
    let now = 1_000_000,
      recover = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = setup();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let primaryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const model = modelOf(init);
        if (model !== primary) return answer(model);
        primaryCalls++;
        return recover ? pending : new Response(null, { status: 503 });
      }),
    );
    await client.call(messages, options);
    now += 60_000;
    recover = true;
    const probe = client.call(messages, options);
    expect((await client.call(messages, options)).model).toBe(backup);
    expect(primaryCalls).toBe(2);
    release(answer(primary));
    expect((await probe).model).toBe(primary);
  });

  it("backs off repeated failures exponentially, capped at fifteen minutes", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = setup();
    let primaryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const model = modelOf(init);
        if (model === primary) {
          primaryCalls++;
          return new Response(null, { status: 503 });
        }
        return answer(model);
      }),
    );
    await client.call(messages, options);
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const before = primaryCalls;
      now += delay - 1;
      await client.call(messages, options);
      expect(primaryCalls).toBe(before);
      now++;
      await client.call(messages, options);
      expect(primaryCalls).toBe(before + 1);
    }
  });

  it("does not quarantine a model for a request-specific context or schema rejection", async () => {
    const { client } = setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "context_length_exceeded" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(answer(backup))
      .mockResolvedValueOnce(answer(primary));
    vi.stubGlobal("fetch", fetcher);
    await client.call(messages, options);
    expect((await client.call(messages, options)).model).toBe(primary);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(
      Response.json({ error: { code: "invalid_schema" } }, { status: 400 }),
    );
    await expect(client.call(messages, options)).rejects.toThrow("(400)");
    fetcher.mockResolvedValueOnce(answer(primary));
    expect((await client.call(messages, options)).model).toBe(primary);
  });

  it("never penalizes a caller cancellation or bypasses a revoked role", async () => {
    const { client, routing } = setup();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      }),
    );
    await expect(
      client.call(messages, { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const fetcher = vi.fn(async () => answer(primary));
    vi.stubGlobal("fetch", fetcher);
    expect((await client.call(messages, options)).model).toBe(primary);
    routing.assertRoleModel.mockImplementation(() => {
      throw new Error("revoked");
    });
    await expect(client.call(messages, options)).rejects.toThrow("revoked");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    new TypeError("Synthetic network failure"),
    new DOMException("Synthetic timeout", "TimeoutError"),
  ])(
    "cools a transport failure without repeating it on the next request",
    async (failure) => {
      const { client } = setup();
      const seen: string[] = [];
      let fail = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          const model = modelOf(init);
          seen.push(model);
          if (model === primary && fail) {
            fail = false;
            throw failure;
          }
          return answer(model);
        }),
      );
      expect((await client.call(messages, options)).model).toBe(backup);
      expect((await client.call(messages, options)).model).toBe(backup);
      expect(seen).toEqual([primary, backup, backup]);
    },
  );

  it.each([
    { header: "Thu, 01 Jan 1970 00:18:10 GMT", delay: 90_000 },
    { header: "999999999", delay: 900_000 },
    { header: "not-a-date", delay: 60_000 },
  ])("bounds Retry-After $header", async ({ header, delay }) => {
    let now = 1_000_000,
      healthy = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = setup();
    let primaryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const model = modelOf(init);
        if (model === primary) {
          primaryCalls++;
          if (!healthy)
            return new Response(null, {
              status: 429,
              headers: { "retry-after": header },
            });
        }
        return answer(model);
      }),
    );
    await client.call(messages, options);
    now += delay - 1;
    healthy = true;
    expect((await client.call(messages, options)).model).toBe(backup);
    expect(primaryCalls).toBe(1);
    now++;
    expect((await client.call(messages, options)).model).toBe(primary);
    expect(primaryCalls).toBe(2);
  });

  it("clears old health state after gateway credential changes and leaves native auto selection alone", async () => {
    const { client, config } = setup();
    let failing = true;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      modelOf(init) === primary && failing
        ? new Response(null, { status: 503 })
        : answer(modelOf(init)),
    );
    vi.stubGlobal("fetch", fetcher);
    await client.call(messages, options);
    failing = false;
    config.omniKey = "replacement-fixture";
    expect((await client.call(messages, options)).model).toBe(primary);
    const auto = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", auto);
    await expect(client.call(messages)).rejects.toThrow("(429)");
    await expect(client.call(messages)).rejects.toThrow("(429)");
    expect(auto).toHaveBeenCalledTimes(2);
  });
});
