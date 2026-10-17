import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { AuditService } from "../core/audit/audit.service.js";
import { AdapterError } from "./adapters.js";
import { ApiEngine, describeIntegration } from "./api-engine.service.js";

const ID = /^[a-z0-9_]{1,40}$/;

/** App-guarded management of connected APIs for the settings page (same engine as the api_* tools). Never returns a credential. */
@Controller("apis")
export class ApisController {
  constructor(
    private readonly engine: ApiEngine,
    private readonly audit: AuditService,
  ) {}

  private id(value: string): string {
    if (!ID.test(value)) throw new BadRequestException("Ongeldige koppeling");
    return value;
  }

  private async guard<T>(work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AdapterError)
        throw new BadRequestException(error.message);
      throw new BadRequestException(
        this.engine.vault
          .redact(error instanceof Error ? error.message : "Mislukt")
          .slice(0, 300),
      );
    }
  }

  @Get()
  list() {
    return {
      integrations: this.engine.registry
        .list()
        .map((i) => describeIntegration(i, this.engine.vault)),
    };
  }

  @Post()
  @HttpCode(200)
  connect(@Body() body: Record<string, unknown>) {
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value.length <= max
        ? value.trim()
        : undefined;
    const baseUrl = text(body?.baseUrl, 500);
    if (!baseUrl) throw new BadRequestException("Vul het adres van de API in.");
    const token = text(body?.token, 4000);
    return this.guard(async () => {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_api_connect",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: {
          baseUrl,
          name: text(body?.name, 60),
          local: body?.localNetwork === true,
          tokenProvided: Boolean(token),
        },
      });
      const { integration, verified } = await this.engine.connect({
        baseUrl,
        name: text(body?.name, 60),
        local: body?.localNetwork === true,
        token,
        docsUrl: text(body?.docsUrl, 500),
      });
      return {
        ...describeIntegration(integration, this.engine.vault),
        loginVerified: verified,
      };
    });
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@Param("id") id: string) {
    return this.guard(async () => {
      const { integration } = await this.engine.test(this.id(id));
      return describeIntegration(integration, this.engine.vault);
    });
  }

  @Delete(":id")
  @HttpCode(200)
  remove(@Param("id") id: string) {
    return this.guard(() => {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_api_remove",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { id },
      });
      return { removed: this.engine.remove(this.id(id)) };
    });
  }
}
