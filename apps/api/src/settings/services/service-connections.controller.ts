import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ValidationError } from "../../core/errors/validation.error.js";
import { MqttService } from "../../core/mqtt/mqtt.service.js";
import { ServiceConnectionsStore } from "./service-connections.store.js";
import { ServiceConnectionsAdapter } from "./service-connections.adapter.js";
import { SemanticMemoryService } from "../../memory/semantic-memory.service.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ServiceConnectionsHistory } from "./service-connections-history.service.js";

import { decodeWindowsPairCode } from "./windows-pairing.js";

type Change = { values?: unknown; clearSecrets?: unknown } | undefined;
@Controller("settings/services")
export class ServiceConnectionsController {
  constructor(
    private readonly store: ServiceConnectionsStore,
    private readonly adapters: ServiceConnectionsAdapter,
    private readonly mqtt: MqttService,
    private readonly memory: SemanticMemoryService,
    private readonly audit: AuditService,
    private readonly rollbackHistory: ServiceConnectionsHistory,
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
  @Get("qdrant/overview") async qdrantOverview() {
    const [overview, health] = await Promise.all([
      this.adapters.qdrantOverview(this.store.effective("qdrant")),
      this.memory.qdrantHealth(),
    ]);
    return { ...overview, activeMemoryCollection: health.collection ?? null };
  }
  @Post("qdrant/maintenance")
  @HttpCode(200)
  qdrantMaintenance() {
    return this.memory.qdrant.maintain();
  }
  @Post("qdrant/reindex")
  @HttpCode(200)
  async qdrantReindex() {
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_qdrant_reindex",
        risk: "DANGEROUS",
        confirmation: "admin_ui",
        arguments: { what: "qdrant_reindex" },
        phase: "attempt",
      });
    } catch {
      return {
        ok: false,
        error: "Auditlog niet beschikbaar; herindexeren gestopt.",
      };
    }
    const result = await this.memory.reindexQdrant();
    const points = "points" in result ? (result.points ?? 0) : 0;
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_qdrant_reindex",
        risk: "DANGEROUS",
        confirmation: "admin_ui",
        arguments: { what: "qdrant_reindex", points },
        result: { ok: result.ok },
        phase: result.ok ? "verified" : "failed",
      });
    } catch {
      // The attempt is already durable; do not hide the reindex result.
    }
    return result;
  }
  @Get("qdrant/index-history")
  async qdrantIndexHistory() {
    const [health, revisions] = await Promise.all([
      this.memory.qdrantHealth(),
      this.memory.qdrantIndexHistory(),
    ]);
    return {
      activeCollection: health.collection ?? null,
      revisions,
    };
  }
  @Post("qdrant/index-history/:id/rollback")
  @HttpCode(200)
  async rollbackQdrantIndex(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return { ok: false, error: "Ongeldige indexwijziging." };
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_qdrant_index_rollback",
        risk: "DANGEROUS",
        confirmation: "admin_ui",
        arguments: { revision: id },
        phase: "attempt",
      });
    } catch {
      return {
        ok: false,
        error: "Auditlog niet beschikbaar; herstel gestopt.",
      };
    }
    const result = await this.memory.rollbackQdrantIndex(id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_qdrant_index_rollback",
        risk: "DANGEROUS",
        confirmation: "admin_ui",
        arguments: { revision: id },
        result: { ok: result.ok },
        phase: result.ok ? "verified" : "failed",
      });
    } catch {
      // The attempt is already durable; return the actual restoration result.
    }
    return result;
  }
  @Post("windows/pair")
  @HttpCode(200)
  pairWindows(@Body() body: { code?: unknown } | undefined) {
    const values = decodeWindowsPairCode(body?.code);
    const services = this.store.save("windows", values, []);
    return {
      ok: true,
      services,
      ...(this.store.auditWarning
        ? { auditWarning: this.store.auditWarning }
        : {}),
    };
  }
  @Get(":id/status") status(@Param("id") id: string) {
    return { test: this.adapters.status(id, this.store.effective(id)) };
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
    return this.rollbackHistory.rollback(revision);
  }
}
