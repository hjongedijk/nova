import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { AppModule } from "./app.module.js";
import { NovaConfig } from "./core/config/nova-config.js";

async function bootstrap() {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  app.setGlobalPrefix("api", {
    exclude: ["windows-agent/{*path}", "nova-ca.crt"],
  });
  app.enableShutdownHooks();
  await app.init();

  const config = app.get(NovaConfig);
  const log = new Logger("NOVA");
  http
    .createServer(server)
    .listen(config.port, () => log.log(`http on :${config.port}`));

  // HTTPS on the LAN (microphone and app install need it) when a certificate is present.
  const cert = path.join(config.certDir, "cert.pem");
  const key = path.join(config.certDir, "key.pem");
  if (config.httpsPort && fs.existsSync(cert) && fs.existsSync(key)) {
    https
      .createServer(
        { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
        server,
      )
      .listen(config.httpsPort, () => log.log(`https on :${config.httpsPort}`));
  }
}

void bootstrap();
