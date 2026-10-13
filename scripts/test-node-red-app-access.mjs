import "reflect-metadata";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { AppAccessController } from "../apps/api/dist/access/access.controller.js";
import { AppAccessGuard } from "../apps/api/dist/access/access.guard.js";
import { AppAccessService } from "../apps/api/dist/access/access.service.js";
import { NovaConfig } from "../apps/api/dist/core/config/nova-config.js";
import { TtsController } from "../apps/api/dist/tts/tts.controller.js";
import { TtsService } from "../apps/api/dist/tts/tts.service.js";

const require = createRequire(import.meta.url);
const {
  request,
} = require("../deploy/nodered/node-red-contrib-nova/shared.js");
const previousToken = process.env.NOVA_APP_TOKEN;
const previousUrl = process.env.NOVA_API_URL;
const fixtureToken = "private-runtime-fixture-not-a-real-credential";
let calls = 0;
let app;
async function boot(port) {
  const module = await Test.createTestingModule({
    controllers: [AppAccessController, TtsController],
    providers: [
      AppAccessService,
      { provide: NovaConfig, useValue: { appToken: fixtureToken } },
      { provide: APP_GUARD, useClass: AppAccessGuard },
      {
        provide: TtsService,
        useValue: {
          async speak() {
            calls++;
            return {
              audio: Buffer.from("synthetic-audio"),
              contentType: "audio/mpeg",
              cached: false,
            };
          },
        },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix("api");
  // Isolate cookie renewal from the separate stale-TCP-connection failure mode.
  app.use((_request, response, next) => {
    response.setHeader("Connection", "close");
    next();
  });
  await app.listen(port, "127.0.0.1");
  return app.getHttpServer().address().port;
}
try {
  const port = await boot(0);
  process.env.NOVA_APP_TOKEN = fixtureToken;
  process.env.NOVA_API_URL = `http://127.0.0.1:${port}`;
  const options = { audio: true };
  assert.equal(
    (await request("/api/tts", { text: "Fixture" }, options)).toString(),
    "synthetic-audio",
  );
  assert.equal(calls, 1);
  await app.close();
  await boot(port);
  // The node retains its old cookie; a fresh API process must reject it before execution.
  assert.equal(
    (await request("/api/tts", { text: "Fixture" }, options)).toString(),
    "synthetic-audio",
  );
  assert.equal(calls, 2, "session renewal must not dispatch the action twice");
  console.log(
    "Real HTTP integration PASS: private Node-RED app session, API restart, safe renewal and exactly one dispatch per request.",
  );
} finally {
  if (app) await app.close();
  if (previousToken === undefined) delete process.env.NOVA_APP_TOKEN;
  else process.env.NOVA_APP_TOKEN = previousToken;
  if (previousUrl === undefined) delete process.env.NOVA_API_URL;
  else process.env.NOVA_API_URL = previousUrl;
}
