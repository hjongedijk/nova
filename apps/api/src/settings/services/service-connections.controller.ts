import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../../core/errors/validation.error.js";
import { SettingsGuard } from "../settings.guard.js";
import { MqttService } from "../../core/mqtt/mqtt.service.js";
import { ServiceConnectionsStore } from "./service-connections.store.js";
import { ServiceConnectionsAdapter } from "./service-connections.adapter.js";

type Change = { values?: unknown; clearSecrets?: unknown } | undefined;
@Controller("settings/services")
@UseGuards(SettingsGuard)
export class ServiceConnectionsController {
  constructor(
    private readonly store: ServiceConnectionsStore,
    private readonly adapters: ServiceConnectionsAdapter,
    private readonly mqtt: MqttService,
  ) {}

  @Get() list() {
    return { services: this.store.list() };
  }
  @Get("history") history() {
    return { revisions: this.store.history() };
  }
  @Get("mqtt/overview") mqttOverview() {
    return this.mqtt.overview();
  }
  @Get("qdrant/overview") qdrantOverview() {
    return this.adapters.qdrantOverview(this.store.effective("qdrant"));
  }
  @Get(":id/status") status(@Param("id") id: string) {
    return { test: this.adapters.status(id) };
  }
  @Put(":id") save(@Param("id") id: string, @Body() body: Change) {
    const services = this.store.save(id, body?.values, body?.clearSecrets);
    return {
      ok: true,
      services,
      ...(this.store.auditWarning
        ? { auditWarning: this.store.auditWarning }
        : {}),
    };
  }
  @Post(":id/test")
  @HttpCode(200)
  test(@Param("id") id: string, @Body() body: Change) {
    return this.adapters.test(
      id,
      this.store.candidate(id, body?.values ?? {}, body?.clearSecrets),
    );
  }
  @Post("history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("revision") revision: string) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige wijziging."]);
    const services = this.store.rollback(revision);
    return {
      ok: true,
      services,
      ...(this.store.auditWarning
        ? { auditWarning: this.store.auditWarning }
        : {}),
    };
  }
}
