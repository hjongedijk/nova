import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  IncompleteModelResponseError,
  OmniRouteClient,
  type ModelInputMessage,
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

describe("OmniRoute HTTP failure cleanup and bounded fallback", () => {
  afterEach(() => vi.unstubAllGlobals());
  const messages = [{ role: "user" as const, content: "Return NOVA_OK only" }];
  const preferred = "gemini/free-fixture";
  const fallback = "mistral/free-fixture";

  function setup() {
    const routing = {
      assertFree: vi.fn(() => ({})),
      roleModels: vi.fn(() => [preferred, fallback]),
      assertRoleModel: vi.fn((_role: string, model: string) => model),
    };
    const client = new OmniRouteClient(
      {
        omniUrl: "http://gateway.test/v1",
        omniKey: "fixture",
        omniModel: "auto",
        omniCompression: "off",
      } as NovaConfig,
      routing as unknown as RoutingService,
    );
    return { client, routing };
  }
  const rejected = (status: number, cancel: () => void) =>
    new Response(new ReadableStream<Uint8Array>({ cancel }), { status });

  it("cancels a rate-limited response before trying the verified fallback once", async () => {
    const cancel = vi.fn();
    const { client, routing } = setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(rejected(429, cancel))
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        return new Response(
          JSON.stringify({
            model: fallback,
            choices: [
              {
                message: { role: "assistant", content: "NOVA_OK" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    vi.stubGlobal("fetch", fetcher);
    const answer = await client.call(messages, {
      roleModel: { role: "conversation", modelId: preferred },
    });
    expect(answer.assistant.content).toBe("NOVA_OK");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model),
    ).toEqual([preferred, fallback]);
    expect(routing.assertFree).toHaveBeenCalledOnce();
    expect(routing.assertRoleModel).toHaveBeenLastCalledWith(
      "conversation",
      fallback,
    );
  });

  it.each([
    { error: { code: "context_length_exceeded" } },
    {
      errors: [
        {
          code: 8007,
          message:
            "Input token count and requested output exceed model context.",
        },
      ],
    },
  ])(
    "tries the next verified model after a context rejection",
    async (error) => {
      const { client } = setup();
      const rejectedResponse = Response.json(error, { status: 400 });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(rejectedResponse)
        .mockImplementationOnce(async () => {
          expect(rejectedResponse.bodyUsed).toBe(true);
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: "NOVA_OK" },
                finish_reason: "stop",
              },
            ],
          });
        });
      vi.stubGlobal("fetch", fetcher);
      const answer = await client.call(messages, {
        roleModel: { role: "conversation", modelId: preferred },
        maxTokens: 2400,
      });
      expect(answer.assistant.content).toBe("NOVA_OK");
      expect(fetcher).toHaveBeenCalledTimes(2);
      const bodies = fetcher.mock.calls.map((call) =>
        JSON.parse(String(call[1]?.body)),
      );
      expect(bodies.map((body) => body.model)).toEqual([preferred, fallback]);
      expect(bodies[0].messages).toEqual(bodies[1].messages);
      expect(bodies[1].max_tokens).toBe(2400);
    },
  );

  it.each([
    { error: { code: "invalid_request", message: "Bad schema" } },
    { errors: [{ code: 8007, message: "An unrelated model rejection" }] },
    {
      errors: [
        { code: 8007, message: "context token output " + "x".repeat(8192) },
      ],
    },
  ])(
    "does not reinterpret other or oversized 400 errors as context overflow",
    async (error) => {
      const { client } = setup();
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json(error, { status: 400 }));
      vi.stubGlobal("fetch", fetcher);
      await expect(
        client.call(messages, {
          roleModel: { role: "conversation", modelId: preferred },
        }),
      ).rejects.toThrow("OmniRoute request failed (400)");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("cancels every failed attempt and stops after the configured free choices", async () => {
    const first = vi.fn();
    const last = vi.fn();
    const { client } = setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(rejected(429, first))
      .mockResolvedValueOnce(rejected(503, last));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      client.call(messages, {
        roleModel: { role: "conversation", modelId: preferred },
      }),
    ).rejects.toThrow("OmniRoute request failed (503)");
    expect(first).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("releases a failed auto response without retrying outside the native router", async () => {
    const cancel = vi.fn();
    const { client } = setup();
    const fetcher = vi.fn().mockResolvedValue(rejected(429, cancel));
    vi.stubGlobal("fetch", fetcher);
    await expect(client.call(messages)).rejects.toThrow(
      "OmniRoute request failed (429)",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("OmniRoute tool-result transport compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function client() {
    const config = new NovaConfig();
    const routing = new RoutingService(config);
    vi.spyOn(routing, "assertFree").mockReturnValue({
      freeOnly: true,
      ready: true,
      policyVerified: true,
      status: "OK",
    });
    return new OmniRouteClient(config, routing);
  }

  it("completes a tool round when the provider rejects null assistant content", async () => {
    const toolCall = {
      id: "fixture-call-1",
      type: "function" as const,
      function: { name: "fixture_lookup", arguments: '{"day":"today"}' },
    };
    const wires: ModelInputMessage[][] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body))
        .messages as ModelInputMessage[];
      wires.push(messages);
      if (
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === null &&
            message.tool_calls?.length,
        )
      )
        return Response.json(
          { error: "assistant.content must be a string" },
          { status: 400 },
        );
      return Response.json({
        choices: [
          {
            finish_reason: wires.length === 1 ? "tool_calls" : "stop",
            message:
              wires.length === 1
                ? { role: "assistant", content: null, tool_calls: [toolCall] }
                : { role: "assistant", content: "Gevonden." },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const api = client();
    const first = await api.call([{ role: "user", content: "Zoek vandaag." }]);
    const followup: ModelInputMessage[] = [
      { role: "user", content: "Zoek vandaag. password: fixture-private" },
      first.assistant,
      {
        role: "tool",
        tool_call_id: toolCall.id,
        name: "fixture_lookup",
        content: "today",
      },
    ];
    const original = structuredClone(followup);
    Object.freeze(first.assistant);
    const answer = await api.call(followup);
    expect(answer.assistant.content).toBe("Gevonden.");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wires[1]).toEqual([
      { role: "user", content: "Zoek vandaag. password: [redacted]" },
      { ...original[1], content: "" },
      original[2],
    ]);
    expect(followup).toEqual(original);
    expect(first.assistant.content).toBeNull();
  });

  it("preserves real content, non-assistant messages and null without tool calls", async () => {
    const toolCall = {
      id: "fixture-call-2",
      type: "function" as const,
      function: { name: "fixture_lookup", arguments: '{"limit":2}' },
    };
    const messages: ModelInputMessage[] = [
      { role: "assistant", content: "Even kijken.", tool_calls: [toolCall] },
      { role: "assistant", content: null },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", content: null, tool_call_id: "fixture-call-2" },
      { role: "user", content: null },
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall],
        name: "nova",
      },
    ];
    const original = structuredClone(messages);
    let wire: ModelInputMessage[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        wire = JSON.parse(String(init?.body)).messages;
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Klaar." },
            },
          ],
        });
      }),
    );
    await client().call(messages);
    expect(wire).toEqual([
      ...original.slice(0, -1),
      { ...original.at(-1), content: "" },
    ]);
    expect(messages).toEqual(original);
  });
});
