import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesktopController } from "../../src/desktop/desktop.controller.js";
import { DesktopService } from "../../src/desktop/desktop.service.js";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ApiErrorFilter } from "../../src/core/errors/validation.error.js";

describe("desktop preview boundary", () => {
  let app: INestApplication;
  const previewFrame = vi.fn(async () => ({
    ok: true,
    screenshot: {
      mimeType: "image/jpeg",
      base64: "Zml4dHVyZQ==",
      width: 960,
      height: 540,
      display: 1,
    },
  }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DesktopController],
      providers: [
        { provide: DesktopService, useValue: { previewFrame } },
        { provide: AuditService, useValue: {} },
        { provide: NovaConfig, useValue: { adminPin: "1234" } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
  });
  afterAll(() => app.close());
  it("returns uncached frames only for a valid display selection", async () => {
    const result = await request(app.getHttpServer())
      .get("/settings/desktop/frame?display=1")
      .set("x-nova-pin", "1234")
      .expect(200);
    expect(result.headers["cache-control"]).toBe("no-store, private");
    expect(previewFrame).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    previewFrame.mockClear();
    for (const display of ["-1", "1.5", "33", "1&display=2", "NaN"]) {
      await request(app.getHttpServer())
        .get(`/settings/desktop/frame?display=${display}`)
        .set("x-nova-pin", "1234")
        .expect(400);
    }
    expect(previewFrame).not.toHaveBeenCalled();
  });
});
