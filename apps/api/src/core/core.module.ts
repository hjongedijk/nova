import { Global, Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuditService } from "./audit/audit.service.js";
import { NovaConfig } from "./config/nova-config.js";
import { closeAllNovaDbs } from "./db/nova-db.js";
import { ApiErrorFilter } from "./errors/validation.error.js";
import { MqttService } from "./mqtt/mqtt.service.js";
import { StateService } from "./state/state.service.js";

/** Shared basics every module may use. Holds no domain logic. */
@Global()
@Module({
  providers: [
    NovaConfig,
    AuditService,
    StateService,
    MqttService,
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
  exports: [NovaConfig, AuditService, StateService, MqttService],
})
export class CoreModule implements OnModuleDestroy {
  /** Checkpoint and close nova.db on shutdown; connections reopen on demand. */
  onModuleDestroy(): void {
    closeAllNovaDbs();
  }
}
