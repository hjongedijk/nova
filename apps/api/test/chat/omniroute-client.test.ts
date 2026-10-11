import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";

describe("OmniRoute prompt privacy boundary", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redacts credential-shaped text immediately before model transport", async () => {
    process.env.OMNIROUTE_API_KEY = "fixture-omniroute-key";
    const config = new NovaConfig();
    const routing = new RoutingService(config);
    vi.spyOn(routing, "assertFree").mockReturnValue({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
    });
    let sent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response(
          JSON.stringify({
            model: "fixture-model",
            choices: [
              { message: { role: "assistant", content: "Veilig verwerkt." } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = new OmniRouteClient(config, routing);
    await client.call([
      { role: "user", content: "password: do-not-send-chat-secret" },
    ]);

    expect(sent).toContain("password: [redacted]");
    expect(sent).not.toContain("do-not-send-chat-secret");
  });

  it("allows a bounded temperature override for repeatable evaluations", async () => {
    process.env.OMNIROUTE_API_KEY = "fixture-omniroute-key";
    const config = new NovaConfig();
    const routing = new RoutingService(config);
    vi.spyOn(routing, "assertFree").mockReturnValue({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
    });
    let sent: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            model: "fixture-model",
            choices: [{ message: { role: "assistant", content: "Antwoord." } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = new OmniRouteClient(config, routing);
    await client.call([{ role: "user", content: "Vraag" }], {
      temperature: 0,
    });
    expect(sent.temperature).toBe(0);
    await expect(
      client.call([{ role: "user", content: "Vraag" }], {
        temperature: 2.1,
      }),
    ).rejects.toThrow("Invalid model temperature");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
