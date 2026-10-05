import { Controller, Get, NotFoundException, Res } from "@nestjs/common";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";

/**
 * The few files people download from NOVA itself, outside /api:
 *  - the Windows agent, so an existing install can be updated from the settings screen;
 *  - the certificate authority NOVA's HTTPS certificate was signed by (public part only), for devices
 *    that should trust it.
 * Nothing else is ever served from these folders.
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

  @Get("windows-agent/jarvis-agent.ps1")
  agent(@Res() response: Response): void {
    this.send(
      response,
      path.join(this.config.agentsDir, "windows", "jarvis-agent.ps1"),
      "jarvis-agent.ps1",
      "application/octet-stream",
    );
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
