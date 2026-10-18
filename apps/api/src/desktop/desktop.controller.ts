import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { isDesktopTool } from "./desktop.audit.js";
import { DesktopService } from "./desktop.service.js";
import type { DesktopSettings } from "./desktop.types.js";

const KEYS: (keyof DesktopSettings)[] = [
  "viewEnabled",
  "controlEnabled",
  "cacheEnabled",
];

/** The Bureaublad settings section: switches, session status, stop button and the audit list. */
@Controller("settings/desktop")
export class DesktopController {
  constructor(
    private readonly desktop: DesktopService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async overview() {
    const status = await this.desktop.status(AbortSignal.timeout(8000));
    return {
      ...status,
      audit: this.audit
        .read(500)
        .filter((entry) => isDesktopTool(String(entry.tool ?? "")))
        .slice(0, 40)
        .map((entry) => ({
          id: entry.id,
          at: entry.timestamp,
          tool: entry.tool,
          risk: entry.risk,
          confirmation: entry.confirmation,
          phase: entry.phase,
          reason: entry.reason,
          arguments: entry.arguments,
          ok: (entry.result as { ok?: boolean } | undefined)?.ok,
        })),
    };
  }

  @Get("frame")
  @Header("Cache-Control", "no-store, private")
  frame(@Query("display") display?: string) {
    if (
      display !== undefined &&
      (typeof display !== "string" ||
        !/^(?:0|[1-9]|[12][0-9]|3[0-2])$/.test(display))
    )
      throw new ValidationError(["Ongeldig beeldscherm."]);
    return this.desktop.previewFrame(
      Number(display ?? 0),
      AbortSignal.timeout(8000),
    );
  }

  @Put()
  update(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !KEYS.includes(key as never)) ||
      Object.values(body).some((value) => typeof value !== "boolean")
    )
      throw new ValidationError(["Ongeldige bureaublad-instellingen."]);
    return {
      settings: this.desktop.updateSettings(body as Partial<DesktopSettings>),
    };
  }

  /** Always allowed, also when everything is switched off. */
  @Post("stop")
  @HttpCode(200)
  async stop() {
    return this.desktop.stop("user", "settings");
  }
}
