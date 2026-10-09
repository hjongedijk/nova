import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { pdf, docx, png } from "./fixtures.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import { listen, fakeConfig } from "../integrations/helpers.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";

// Exercise the HTTP request through orchestration to the model boundary.
describe("chat attachments", () => {
  let app: NestExpressApplication;
  const model = vi.fn().mockResolvedValue({
    assistant: { role: "assistant", content: "The total is 42." },
    model: "fixture",
    usage: null,
    metadata: {},
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.useBodyParser("json", { limit: "42mb" });
    app.setGlobalPrefix("api");
    vi.spyOn(app.get(OmniRouteClient), "configured", "get").mockReturnValue(
      true,
    );
    vi.spyOn(app.get(OmniRouteClient), "call").mockImplementation(model);
    vi.spyOn(app.get(RoutingService), "assertFree").mockReturnValue(
      app.get(RoutingService).status(),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it.each(["chat", "chat-stream"])(
    "%s delivers named file contents to the model",
    async (endpoint) => {
      model.mockClear();
      const response = await request(app.getHttpServer())
        .post(`/api/${endpoint}`)
        .send({
          sessionId: endpoint,
          message: "Summarize this file",
          attachments: [{ name: "numbers.csv", content: "total\n42" }],
        })
        .expect(201);
      expect(response.text).toContain("The total is 42.");
      const messages = model.mock.calls[0]![0];
      const attached = messages.find((message: { content: string }) =>
        message.content?.includes("numbers.csv"),
      );
      expect(attached.role).toBe("user");
      expect(attached.content).toContain("untrusted reference data");
      expect(JSON.parse(attached.content.split("\n")[1])).toEqual([
        { name: "numbers.csv", content: "total\n42", truncated: false },
      ]);
    },
  );

  it.each([
    null,
    [{ name: "../secrets.txt", content: "x" }],
    [{ name: "image.png", content: "x" }],
    [{ name: "binary.txt", content: "\0" }],
    [{ name: "large.txt", content: "x".repeat(10 * 1024 * 1024 + 1) }],
    Array.from({ length: 6 }, () => ({ name: "a.txt", content: "x" })),
    [{ name: "a.txt", content: 123 }],
  ])(
    "rejects invalid attachments before calling the model",
    async (attachments) => {
      model.mockClear();
      await request(app.getHttpServer())
        .post("/api/chat")
        .send({
          sessionId: "invalid",
          message: "Read this",
          attachments,
        })
        .expect(400);
      expect(model).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "invoice.pdf",
      mimeType: "application/pdf",
      data: pdf(),
      expected: "Invoice total 42 EUR",
    },
    {
      name: "plan.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: docx(),
      expected: "Dinner & a walk",
    },
  ])("extracts actual $name before sending it to the model", async (file) => {
    model.mockClear();
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({
        sessionId: file.name.replace(".", "-"),
        message: "Summarize the document",
        attachments: [
          {
            name: file.name,
            encoding: "base64",
            mimeType: file.mimeType,
            content: file.data.toString("base64"),
          },
        ],
      })
      .expect(201);
    expect(JSON.stringify(model.mock.calls[0]![0])).toContain(file.expected);
  });

  it("sends images using vision content parts, with the user's question last", async () => {
    model.mockClear();
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({
        sessionId: "vision",
        message: "What is in this picture?",
        attachments: [
          {
            name: "photo.png",
            encoding: "base64",
            mimeType: "image/png",
            content: png.toString("base64"),
          },
        ],
      })
      .expect(201);
    const last = model.mock.calls[0]![0].at(-1);
    expect(last.content).toContainEqual({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${png.toString("base64")}`,
        detail: "auto",
      },
    });
    expect(last.content.at(-1).text).toContain(
      "User's question: What is in this picture?",
    );
  });

  it("accepts larger files and announces bounded text excerpts in the stream", async () => {
    model.mockClear();
    const response = await request(app.getHttpServer())
      .post("/api/chat-stream")
      .send({
        sessionId: "long-file",
        message: "Summarize this",
        attachments: [{ name: "long.txt", content: "x".repeat(150000) }],
      })
      .expect(201);
    expect(response.text).toContain("event: attachment_notice");
    const attached = model.mock.calls[0]![0].at(-1);
    const files = JSON.parse(attached.content.split("\n")[1]);
    expect(files[0].truncated).toBe(true);
    expect(files[0].content).toHaveLength(24000);
  });

  it("rejects a malformed PDF with a useful error before calling the model", async () => {
    model.mockClear();
    const response = await request(app.getHttpServer())
      .post("/api/chat")
      .send({
        sessionId: "bad-pdf",
        message: "Read this",
        attachments: [
          {
            name: "broken.pdf",
            encoding: "base64",
            mimeType: "application/pdf",
            content: Buffer.from("%PDF-broken").toString("base64"),
          },
        ],
      })
      .expect(400);
    expect(response.body.error).toContain("broken.pdf");
    expect(model).not.toHaveBeenCalled();
  });

  it.each([
    "Ik ben moe, wat een dag.",
    "Ik voel me gestrest over de server.",
    "Bedankt NOVA.",
  ])("does not force tool calls for conversation: %s", async (message) => {
    model.mockClear();
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({ sessionId: "social", message })
      .expect(201);
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]![1].toolChoice).toBeUndefined();
  });

  it("uses the attachment as the source for server-log analysis", async () => {
    model.mockClear();
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({
        sessionId: "logs",
        message: "Explain the server status in this log",
        attachments: [{ name: "server.log", content: "disk usage 90%" }],
      })
      .expect(201);
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]![1].toolChoice).toBeUndefined();
  });

  it("still requires tools for live weather", async () => {
    model.mockClear();
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({ sessionId: "weather", message: "Hoe is het weer buiten?" })
      .expect(201);
    expect(model.mock.calls[0]![1].toolChoice).toBe("required");
  });

  it.each(["text", "voice"])(
    "keeps the %s response style after a tool call",
    async (inputMode) => {
      model.mockClear();
      model.mockResolvedValueOnce({
        assistant: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-call",
              type: "function",
              function: {
                name: "list_show",
                arguments: '{"name":"boodschappen"}',
              },
            },
          ],
        },
        model: "fixture",
        usage: null,
        metadata: {},
      });
      const execute = vi
        .spyOn(app.get(ToolsService), "execute")
        .mockResolvedValueOnce({
          ok: true,
          verified: true,
          result: { items: ["milk"] },
        });
      try {
        await request(app.getHttpServer())
          .post("/api/chat")
          .send({
            sessionId: inputMode,
            inputMode,
            message: "Toon mijn boodschappenlijst",
          })
          .expect(201);
        const messages = model.mock.calls[1]![0];
        const result = JSON.parse(
          messages.find((message: { role: string }) => message.role === "tool")
            .content,
        );
        expect(result.result.items).toEqual(["milk"]);
        expect(result.verified).toBe(true);
        expect(result.response_style).toContain(
          inputMode === "voice" ? "spoken conversation" : "typed chat",
        );
        expect(result.response_style).not.toContain("hooguit vier zinnen");
      } finally {
        execute.mockRestore();
      }
    },
  );

  it("preserves vision parts and the auto route at the real gateway boundary", async () => {
    const gateway = await listen((_seen, send) =>
      send(200, {
        choices: [{ message: { role: "assistant", content: "A picture" } }],
      }),
    );
    try {
      const client = new OmniRouteClient(
        fakeConfig({
          omniUrl: gateway.url,
          omniKey: "fixture",
          omniModel: "auto",
        }),
        app.get(RoutingService),
      );
      const parts = [
        {
          type: "image_url" as const,
          image_url: {
            url: `data:image/png;base64,${png.toString("base64")}`,
            detail: "auto" as const,
          },
        },
      ];
      await client.call([{ role: "user", content: parts }], {
        maxTokens: 2400,
      });
      const body = JSON.parse(gateway.requests[0]!.body);
      expect(body.messages[0].content).toEqual(parts);
      expect(body.model).toBe("auto");
      expect(body.max_tokens).toBe(2400);
      expect(body.provider).toBeUndefined();
    } finally {
      gateway.close();
    }
  });

  it("reports a rejected vision request without attempting a fallback", async () => {
    const gateway = await listen((_seen, send) =>
      send(400, { error: "unsupported image" }),
    );
    try {
      const client = new OmniRouteClient(
        fakeConfig({
          omniUrl: gateway.url,
          omniKey: "fixture",
          omniModel: "auto",
        }),
        app.get(RoutingService),
      );
      await expect(
        client.call([
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${png.toString("base64")}`,
                  detail: "auto",
                },
              },
            ],
          },
        ]),
      ).rejects.toThrow("gratis model dat afbeeldingen kan lezen");
      expect(gateway.requests).toHaveLength(1);
    } finally {
      gateway.close();
    }
  });

  it("preserves ordinary chat without attachments", async () => {
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({ sessionId: "plain", message: "Hello" })
      .expect(201);
  });
});
