import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  type NestExpressApplication,
  ExpressAdapter,
} from "@nestjs/platform-express";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { NodeRedEditorProxy } from "./settings/node-red-editor-proxy.service.js";
import { AppModule } from "./app.module.js";
import { NovaConfig } from "./core/config/nova-config.js";
import { requestGuard } from "./core/security/request-origin.js";

async function bootstrap() {
  const server = express();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
    // JSON only: no urlencoded parser, so a plain cross-site HTML form cannot build a request body.
    { bodyParser: false },
  );
  const config = app.get(NovaConfig);
  // Before every /api route (the Node-RED editor proxy included): refuse other websites and rebound host names.
  server.use(
    "/api",
    requestGuard({
      publicUrl: config.publicUrl,
      allowedHosts: config.allowedHosts,
    }),
  );
  app.setGlobalPrefix("api", {
    exclude: ["nova-ca.crt"],
  });
  const editor = app.get(NodeRedEditorProxy);
  server.use("/api/node-red-editor", editor.middleware);
  const attachEditor = (listener: http.Server | https.Server) => {
    listener.on("upgrade", (request, socket, head) => {
      if (!editor.sockets.upgrade(request, socket, head)) socket.destroy();
    });
    return listener;
  };
  server.use(
    "/api/integrations/node-red/events",
    express.json({ limit: "4kb" }),
  );
  // The Asterisk dialplan CURLs a form (token-checked); the only route that reads one.
  server.use(
    "/api/integrations/asterisk/message",
    express.urlencoded({ extended: false, limit: "64kb" }),
  );
  app.useBodyParser("json", { limit: "42mb" });
  app.enableShutdownHooks();
  await app.init();

  const log = new Logger("NOVA");
  attachEditor(http.createServer(server)).listen(config.port, () =>
    log.log(`http on :${config.port}`),
  );

  // HTTPS on the LAN (microphone and app install need it) when a certificate is present.
  const cert = path.join(config.certDir, "cert.pem");
  const key = path.join(config.certDir, "key.pem");
  if (config.httpsPort && fs.existsSync(cert) && fs.existsSync(key)) {
    attachEditor(
      https.createServer(
        { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
        server,
      ),
    ).listen(config.httpsPort, () => log.log(`https on :${config.httpsPort}`));
  }
}

void bootstrap();
