import { Injectable } from "@nestjs/common";
import type {
  ServiceRestartResult,
  ServiceRestartStatus,
} from "@nova/contracts";
import { AuditService } from "../../core/audit/audit.service.js";
import { NovaConfig } from "../../core/config/nova-config.js";
import { ServiceConnectionsStore } from "./service-connections.store.js";

/** Graceful process restart, enabled only when a supervisor will bring NOVA back. */
@Injectable()
export class ServiceRestart {
  private scheduled = false;
  /** Replaceable in tests. The production deploy uses Docker's unless-stopped policy. */
  scheduleRestart: () => void = () => {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
  };

  constructor(
    private readonly config: NovaConfig,
    private readonly audit: AuditService,
    private readonly connections: ServiceConnectionsStore,
  ) {}

  status(): ServiceRestartStatus {
    const pendingChanges = this.connections
      .list()
      .some((service) => service.restartRequired);
    return {
      available: this.config.restartEnabled,
      pendingChanges,
      restartPending: this.scheduled,
      ...(!this.config.restartEnabled
        ? {
            reason:
              "Gecontroleerd herstarten is voor deze installatie niet ingeschakeld.",
          }
        : !pendingChanges
          ? {
              reason: "Er zijn geen wijzigingen die een herstart nodig hebben.",
            }
          : {}),
    };
  }

  request(): ServiceRestartResult {
    const status = this.status();
    if (!status.available || !status.pendingChanges)
      return { ok: false, error: status.reason };
    if (this.scheduled)
      return { ok: false, error: "De herstart is al aangevraagd." };
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_service_restart",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { pendingChanges: true },
        phase: "before_execute",
      });
      this.scheduled = true;
      this.scheduleRestart();
      return { ok: true, scheduled: true };
    } catch {
      this.scheduled = false;
      return {
        ok: false,
        error: "Herstart kon niet worden ingepland. Probeer het later opnieuw.",
      };
    }
  }
}
