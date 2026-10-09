import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";

// Exercise the HTTP request through orchestration to the model boundary.
describe("chat attachments", () => {
  let app: INestApplication;
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
    app = module.createNestApplication();
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
      expect(
        JSON.parse(attached.content.split("\n").slice(1).join("\n")),
      ).toEqual([{ name: "numbers.csv", content: "total\n42" }]);
    },
  );

  it.each([
    null,
    [{ name: "../secrets.txt", content: "x" }],
    [{ name: "image.png", content: "x" }],
    [{ name: "binary.txt", content: "\0" }],
    [{ name: "large.txt", content: "é".repeat(8193) }],
    Array.from({ length: 4 }, () => ({ name: "a.txt", content: "x" })),
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

  it("preserves ordinary chat without attachments", async () => {
    await request(app.getHttpServer())
      .post("/api/chat")
      .send({ sessionId: "plain", message: "Hello" })
      .expect(201);
  });
});
