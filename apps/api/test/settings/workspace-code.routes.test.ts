import { Test } from "@nestjs/testing";
import request from "supertest";
import { expect, it } from "vitest";
import { SettingsGuard } from "../../src/settings/settings.guard.js";
import { WorkspaceCodeController } from "../../src/settings/workspace-code.controller.js";
import { WorkspaceCodeService } from "../../src/settings/workspace-code.service.js";

it("returns JSON null over HTTP before a workspace run exists", async () => {
  const module = await Test.createTestingModule({
    controllers: [WorkspaceCodeController],
    providers: [
      {
        provide: WorkspaceCodeService,
        useValue: { latestRunReport: () => null },
      },
    ],
  })
    .overrideGuard(SettingsGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix("api");
  await app.init();
  try {
    const response = await request(app.getHttpServer())
      .get("/api/settings/workspace/code/latest-run")
      .expect(200);
    expect(response.text).toBe("null");
    expect(response.headers["content-type"]).toContain("application/json");
  } finally {
    await app.close();
  }
});
