import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  JarvisStateStore,
  MAX_ALERTS,
  newId,
} from "../planning/jarvis-state.store.js";
import { ApiEngine } from "./api-engine.service.js";
import type { ApiIntegration } from "./api.types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILURES_BEFORE_DEGRADED = 3;

export interface MaintenanceRound {
  id: string;
  outcome: "healthy" | "credentials_rejected" | "failing" | "skipped" | "error";
  detail?: string;
  alerts: string[];
}

/**
 * Daily care for every connected API: a read-only probe, credential and outage detection, a weekly re-discovery diff.
 * It reports and marks operations degraded; it never rotates credentials and never changes a mutating operation by itself.
 * Due times are stored with each integration, so a restart neither skips nor repeats a check.
 */
@Injectable()
export class ApiMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger("API maintenance");

  constructor(
    private readonly engine: ApiEngine,
    private readonly state: JarvisStateStore,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(
      () =>
        void this.tick().catch(() => this.log.warn("maintenance round failed")),
      15 * 60_000,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private raise(key: string, title: string, detail: string): void {
    const data = this.state.data;
    if (data.active[key]) return;
    const alert = {
      id: newId(),
      key,
      severity: "warning",
      title,
      detail,
      at: new Date().toISOString(),
    };
    data.alerts.unshift(alert);
    data.alerts.length = Math.min(data.alerts.length, MAX_ALERTS);
    data.active[key] = true;
    this.state.emit({
      topic: "jarvis/alerts",
      payload: { type: "alert", ...alert },
    });
    this.state.save();
  }

  private resolve(id: string): void {
    for (const kind of ["auth", "down", "drift"])
      delete this.state.data.active[`api:${id}:${kind}`];
  }

  private degrade(i: ApiIntegration, only?: string): void {
    for (const op of i.operations)
      if (op.enabled && op.status === "ok" && (!only || op.id === only)) {
        op.status = "degraded";
        op.hints = [
          ...op.hints.filter((h) => !h.startsWith("degraded")),
          "degraded: the last check failed",
        ];
      }
  }

  private restore(i: ApiIntegration): void {
    for (const op of i.operations)
      if (op.status === "degraded") {
        op.status = "ok";
        op.hints = op.hints.filter((h) => !h.startsWith("degraded"));
      }
  }

  /** Check every integration whose time has come. */
  async tick(now = Date.now()): Promise<MaintenanceRound[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const rounds: MaintenanceRound[] = [];
      for (const i of this.engine.registry.list()) {
        if (i.maintenance.nextDueAt > now) continue;
        rounds.push(await this.check(i.id, now));
      }
      return rounds;
    } finally {
      this.running = false;
    }
  }

  async check(id: string, now = Date.now()): Promise<MaintenanceRound> {
    const alerts: string[] = [];
    try {
      const { integration: i, outcome } = await this.engine.test(id);
      const m = i.maintenance;
      let round: MaintenanceRound;
      m.nextDueAt = now + DAY;
      if (!outcome)
        round = {
          id,
          outcome: "skipped",
          detail: "no read-only probe possible",
          alerts,
        };
      else if (outcome.ok) {
        m.failStreak = 0;
        m.authFailStreak = 0;
        if (i.status !== "needs_info") i.status = "ready";
        this.restore(i);
        this.resolve(id);
        round = { id, outcome: "healthy", alerts };
      } else if (outcome.authRejected) {
        m.authFailStreak++;
        i.status = "credentials_expired";
        this.degrade(i);
        const key = `api:${id}:auth`;
        this.raise(
          key,
          `Inloggegevens voor ${i.name} geweigerd`,
          `${i.name} weigert het opgeslagen token of de sleutel (HTTP ${outcome.status}). Waarschijnlijk is die verlopen of ingetrokken. Volgende stap: geef NOVA een nieuw token, bijvoorbeeld "koppel ${i.baseUrl} met token ..." of via Instellingen > Geavanceerd > API's. NOVA vernieuwt zelf nooit een sleutel.`,
        );
        alerts.push(key);
        round = {
          id,
          outcome: "credentials_rejected",
          detail: `HTTP ${outcome.status}`,
          alerts,
        };
      } else {
        m.failStreak++;
        const gone = outcome.status === 410;
        if (gone || m.failStreak >= FAILURES_BEFORE_DEGRADED) {
          i.status = outcome.status === undefined ? "unreachable" : "degraded";
          this.degrade(i, outcome.operation ?? undefined);
          const key = `api:${id}:down`;
          this.raise(
            key,
            `${i.name} werkt niet goed`,
            `${i.name} gaf ${m.failStreak}x achter elkaar een fout (${outcome.status ? `HTTP ${outcome.status}` : (outcome.error ?? "geen antwoord")}). De betrokken acties zijn als 'degraded' gemarkeerd. Volgende stap: controleer of de dienst bereikbaar is of dat het adres is veranderd; NOVA probeert het elk uur opnieuw.`,
          );
          alerts.push(key);
        }
        m.nextDueAt = now + HOUR;
        round = {
          id,
          outcome: "failing",
          detail: outcome.status ? `HTTP ${outcome.status}` : outcome.error,
          alerts,
        };
      }
      this.engine.registry.save(i);
      if (m.nextDiscoveryAt <= now && round.outcome === "healthy") {
        const diff = await this.engine.refresh(id);
        if (
          diff.removed.length ||
          diff.pendingApproval.length ||
          diff.added.length
        ) {
          const key = `api:${id}:drift`;
          delete this.state.data.active[key];
          this.raise(
            key,
            `${i.name}: de API is veranderd`,
            `Nieuw: ${diff.added.length}, verdwenen: ${diff.removed.length}, gewijzigd: ${diff.changedOps.length}, wacht op jouw akkoord: ${diff.pendingApproval.length}. Nieuwe acties die iets wijzigen staan uit totdat je ze goedkeurt (api_describe / api_configure).`,
          );
          alerts.push(key);
        }
      }
      return round;
    } catch (error) {
      const i = this.engine.registry.get(id);
      if (i) {
        i.maintenance.nextDueAt = now + DAY;
        this.engine.registry.save(i);
      }
      return {
        id,
        outcome: "error",
        detail: error instanceof Error ? error.message.slice(0, 120) : "failed",
        alerts,
      };
    }
  }
}
