import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  IncompleteModelResponseError,
  OmniRouteClient,
} from "../../src/chat/omniroute-client.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import fs from "node:fs";
import path from "node:path";

describe("OmniRoute prompt privacy boundary", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redacts credential-shaped text immediately before model transport", async () => {
    process.env.OMNIROUTE_API_KEY = "fixture-omniroute-key";
    const savedSecret = "persisted-prompt-private-value";
    const connectionsFile = path.join(
      process.env.NOVA_DATA_DIR!,
      "services.json",
    );
    fs.writeFileSync(
      connectionsFile,
      JSON.stringify({
        version: 1,
        services: { "home-assistant": { token: savedSecret } },
        history: [],
      }),
    );
    const config = new NovaConfig();
    fs.rmSync(connectionsFile);
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
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "private_fixture",
          description: `Connection value ${savedSecret}`,
          parameters: {
            type: "object",
            properties: {
              password: { type: "string", default: savedSecret },
              api_key: { type: "string", description: `Value ${savedSecret}` },
            },
            required: ["password", "api_key"],
            additionalProperties: false,
          },
        },
      },
    ];
    await client.call(
      [
        {
          role: "user",
          content: `password: do-not-send-chat-secret; Value ${savedSecret}`,
        },
      ],
      { tools },
    );

    expect(sent).toContain("password: [redacted]");
    expect(sent).not.toContain("do-not-send-chat-secret");
    expect(sent).not.toContain(savedSecret);
    expect(sent).toContain("Value [redacted]");
    expect(JSON.parse(sent).tools).toEqual([
      {
        type: "function",
        function: {
          name: "private_fixture",
          description: "Connection value [redacted]",
          parameters: {
            type: "object",
            properties: {
              password: { type: "string", default: "[redacted]" },
              api_key: { type: "string", description: "Value [redacted]" },
            },
            required: ["password", "api_key"],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(tools[0]?.function.parameters.properties.password.default).toBe(
      savedSecret,
    );
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

describe("OmniRoute response completeness", () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = () =>
    new OmniRouteClient(
      {
        omniUrl: "http://gateway.test/v1",
        omniKey: "fixture",
        omniModel: "auto",
        omniCompression: "off",
      } as NovaConfig,
      { assertFree: () => ({}) } as RoutingService,
    );
  const messages = [{ role: "user" as const, content: "Explain." }];
  const frame = (choice: Record<string, unknown>) =>
    `data: ${JSON.stringify({ choices: [choice] })}\n\n`;

  it.each(["length", "content_filter", "unexpected_reason"])(
    "rejects %s completion in JSON and SSE",
    async (reason) => {
      for (const stream of [false, true]) {
        const body = stream
          ? frame({ delta: { content: "An unfinished" } }) +
            frame({ delta: {}, finish_reason: reason }) +
            "data: [DONE]\n\n"
          : JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "An unfinished" },
                  finish_reason: reason,
                },
              ],
            });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
        await expect(
          client().call(messages, { stream }),
        ).rejects.toBeInstanceOf(IncompleteModelResponseError);
      }
    },
  );

  it("rejects EOF without a completion marker after emitted partial tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(frame({ delta: { content: "Partial" } })),
        ),
    );
    const emit = vi.fn();
    await expect(
      client().call(messages, { stream: true, emit }),
    ).rejects.toMatchObject({ reason: "premature_eof" });
    expect(emit).toHaveBeenCalledWith("token", { text: "Partial" });
  });

  it.each(["stop", "tool_calls"])(
    "accepts %s followed by usage without DONE",
    async (reason) => {
      const choice =
        reason === "stop"
          ? { delta: { content: "Complete." }, finish_reason: reason }
          : {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "fixture", arguments: "{}" },
                  },
                ],
              },
              finish_reason: reason,
            };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              frame(choice) + 'data: {"usage":{"completion_tokens":3}}\n\n',
            ),
          ),
      );
      const answer = await client().call(messages, { stream: true });
      expect(answer.usage).toEqual({ completion_tokens: 3 });
      if (reason === "tool_calls")
        expect(answer.assistant.tool_calls?.[0]?.function.arguments).toBe("{}");
      else expect(answer.assistant.content).toBe("Complete.");
    },
  );

  it("finalizes and cancels an open transport after DONE", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame({ delta: { content: "Complete." } }) + "data: [DONE]\n\n",
          ),
        );
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(
      (await client().call(messages, { stream: true })).assistant.content,
    ).toBe("Complete.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid maxTokens %s before dispatch",
    async (maxTokens) => {
      vi.stubGlobal("fetch", vi.fn());
      await expect(client().call(messages, { maxTokens })).rejects.toThrow(
        "Invalid model token limit",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
