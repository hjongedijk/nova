import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";

describe("GET /api/nova/health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api", {
      exclude: ["windows-agent/{*path}", "nova-ca.crt"],
    });
    await app.init();
  });

  afterAll(() => app.close());

  it("says NOVA is up, with its version", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/nova/health")
      .expect(200);
    expect(response.body).toMatchObject({ ok: true, name: "nova" });
    expect(typeof response.body.version).toBe("string");
  });
});
