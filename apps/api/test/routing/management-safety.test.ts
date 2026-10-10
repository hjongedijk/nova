import { describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";

const config = {
  omniUrl: "https://gateway.invalid/v1",
  omniAdminPassword: "original-password",
  omniCompression: "balanced",
} as NovaConfig;

function session(cookie = "session-original"): Response {
  return new Response("{}", {
    headers: { "set-cookie": `auth_token=${cookie}; HttpOnly` },
  });
}

function management(fetcher: typeof fetch): OmniRouteManagement {
  const value = new OmniRouteManagement(config);
  value.configure({ scope: "owner-original", fetcher });
  return value;
}

describe("OmniRoute management response and session boundaries", () => {
  it("cancels a response exceeding the byte limit without exposing its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
        controller.enqueue(new TextEncoder().encode("secret-body-value"));
        controller.enqueue(new Uint8Array(1_000_000));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(session());
    fetcher.mockResolvedValueOnce(new Response(body));
    const value = management(fetcher);
    await expect(value.request("/api/cache/stats")).rejects.toThrow(
      /^OmniRoute management response could not be read$/,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses the same byte limit for raw responses and bounds their returned text", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(session());
    fetcher.mockResolvedValueOnce(new Response("é".repeat(1_000_000)));
    fetcher.mockResolvedValueOnce(new Response("é".repeat(1_000_001)));
    const value = management(fetcher);
    const raw = await value.request<string>("/api/agent-skills/demo/raw", {
      raw: true,
    });
    expect(raw).toHaveLength(16_000);
    await expect(
      value.request("/api/agent-skills/demo/raw", { raw: true }),
    ).rejects.toThrow(/^OmniRoute management response could not be read$/);
  });

  it("reports malformed JSON and stream errors without leaking response details", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(session());
    fetcher.mockResolvedValueOnce(new Response('{"private-token":"secret"'));
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("secret upstream credentials"));
          },
        }),
      ),
    );
    const value = management(fetcher);
    await expect(value.request("/api/cache/stats")).rejects.toThrow(
      /^OmniRoute management response is invalid$/,
    );
    await expect(value.request("/api/cache/stats")).rejects.toThrow(
      /^OmniRoute management response could not be read$/,
    );
  });

  it("logs in again after URL or password changes and never forwards the old cookie", async () => {
    const calls: { url: string; cookie: string | null; body?: string }[] = [];
    let sessions = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        cookie: new Headers(init?.headers).get("cookie"),
        body: init?.body as string | undefined,
      });
      return url.endsWith("/api/auth/login")
        ? session(`session-${++sessions}`)
        : Response.json({ ok: true });
    };
    const value = management(fetcher);
    await value.request("/api/cache/stats");
    value.configure({ url: "https://replacement.invalid" });
    await value.request("/api/cache/stats");
    value.configure({ password: "replacement-password" });
    await value.request("/api/cache/stats");
    expect(calls.map((call) => call.cookie)).toEqual([
      null,
      "auth_token=session-1",
      null,
      "auth_token=session-2",
      null,
      "auth_token=session-3",
    ]);
    expect(
      calls
        .slice(2)
        .every((call) => call.url.startsWith("https://replacement.invalid/")),
    ).toBe(true);
    expect(JSON.parse(calls[4]!.body!)).toEqual({
      password: "replacement-password",
    });
  });

  it("clears cached status and the cookie when scope changes", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/api/auth/login") ? session() : Response.json({}),
    );
    const value = management(fetcher);
    expect((await value.status()).online).toBe(true);
    await value.status();
    expect(fetcher).toHaveBeenCalledTimes(6);
    value.configure({ scope: "owner-replacement" });
    expect(value.scope).toBe("owner-replacement");
    expect((await value.status()).online).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(12);
  });

  it("rejects reconfiguration while a shared login is in flight", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const value = management(fetcher);
    const first = value.login();
    const second = value.login();
    expect(() => value.configure({ password: "replacement-password" })).toThrow(
      "OmniRoute management configuration is in use",
    );
    expect(() =>
      value.configure({ url: "https://replacement.invalid" }),
    ).toThrow();
    complete(session());
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledOnce();
    value.configure({ password: "" });
    expect(value.configured).toBe(false);
    await expect(value.login()).rejects.toThrow("login is not configured");
    expect(await value.status()).toMatchObject({
      configured: false,
      online: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("prevents reconfiguration while an authenticated request is in flight", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(session());
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const value = management(fetcher);
    await value.login();
    const pending = value.request("/api/cache/stats");
    expect(() => value.configure({ scope: "replacement" })).toThrow(
      "OmniRoute management configuration is in use",
    );
    complete(Response.json({ ok: true }));
    await expect(pending).resolves.toEqual({ ok: true });
    expect(() => value.configure({ scope: "replacement" })).not.toThrow();
  });
});
