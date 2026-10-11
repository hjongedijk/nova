import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { AppAccessPublic } from "../access/access-public.js";

/**
 * NOVA itself: up, which version. Lives at /api/nova/health so it does not take over
 * /api/health, which the current interface reads in its own (richer) form.
 */
@Controller("nova")
export class HealthController {
  constructor(private readonly config: NovaConfig) {}

  @Get("health")
  @AppAccessPublic()
  health(): HealthResponse {
    return {
      ok: true,
      name: "nova",
      version: this.config.version,
      uptimeSeconds: Math.round(process.uptime()),
      services: {},
    };
  }
}
