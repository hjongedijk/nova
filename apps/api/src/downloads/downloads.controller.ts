import { Controller, Get, NotFoundException, Res } from "@nestjs/common";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";

/**
 * Downloads NOVA's certificate authority (public part only), outside /api,
 * for devices that should trust its HTTPS certificate. No other files are served.
 */
@Controller()
export class DownloadsController {
  constructor(private readonly config: NovaConfig) {}

  private send(
    response: Response,
    file: string,
    name: string,
    type: string,
  ): void {
    if (!fs.existsSync(file)) throw new NotFoundException();
    response.setHeader("Content-Type", type);
    response.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    response.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(response);
  }

  @Get("nova-ca.crt")
  authority(@Res() response: Response): void {
    this.send(
      response,
      path.join(this.config.certDir, "nova-ca.crt"),
      "nova-ca.crt",
      "application/x-x509-ca-cert",
    );
  }
}
