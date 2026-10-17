import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import { AgentService } from "../agent/agent.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { sanitize } from "../core/security/sanitize.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { ToolsService } from "../tools/tools.service.js";
import { evaluate } from "./objectives.conditions.js";
import {
  CHECK_TOOLS,
  TEMPLATES,
  type TemplateParams,
} from "./objectives.templates.js";
import { inQuietHours, localDay, parseClock } from "./objectives.time.js";
import { ObjectivesStore, emptyFile } from "./objectives.store.js";
import {
  DEFAULT_QUIET,
  LIMITS,
  ObjectiveError,
  type ActiveAnomaly,
  type Objective,
  type ObjectiveCheck,
  type ObjectiveKind,
  type ObjectivesFile,
  type ResultStatus,
  type Urgency,
} from "./objectives.types.js";

const DAY = 86_400_000;
const URGENCY_RANK: Record<Urgency, number> = { info: 0, warn: 1, urgent: 2 };
const SEVERITY = { info: "info", warn: "warning", urgent: "critical" } as const;
const short = (text: string, n = 160) =>
  text.replace(/\s+/g, " ").trim().slice(0, n);

export interface CreateInput {
  title?: unknown;
  template?: unknown;
  params?: TemplateParams;
  kind?: unknown;
  intervalMinutes?: unknown;
  cooldownMinutes?: unknown;
  expiresInDays?: unknown;
}

export interface UpdateInput {
  title?: unknown;
  intervalMinutes?: unknown;
  cooldownMinutes?: unknown;
  quietHours?: unknown;
  expiresInDays?: unknown;
  enabled?: unknown;
  /** The user calls the current anomaly a false alarm. */
  dismiss?: unknown;
}

type Gate = "ok" | "stil" | "cooldown" | "budget";

/**
 * Standing objectives. A tick runs the objectives that are due: READ_ONLY tools only, conditions evaluated in code (no model
 * call for routine checks), debounced, de-duplicated, with quiet hours, a per-objective cooldown and a daily notification
 * budget. Only a NEW or CHANGED anomaly starts one budgeted, read-only investigation through AgentService.
 */
@Injectable()
export class ObjectivesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("NOVA objectives");
  private data: ObjectivesFile = emptyFile();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly inflight = new Set<string>();
  /** Replaceable in tests. */
  now: () => number = Date.now;
  tickMs = 30_000;
  pollMs = 2_000;
  investigationPollLimit = 450;

  constructor(
    private readonly store: ObjectivesStore,
    private readonly tools: ToolsService,
    private readonly agent: AgentService,
    private readonly events: JarvisStateStore,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.recover();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reload from disk. Due times come from the stored lastCheckAt, so a restart resumes without a burst of checks. */
  recover(): void {
    this.data = this.store.load();
  }

  // ---- views --------------------------------------------------------------------------------

  list(): Objective[] {
    return [...this.data.objectives].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Objective {
    const found = this.data.objectives.find((o) => o.id === id);
    if (!found) throw new ObjectiveError("Doel niet gevonden.");
    return found;
  }

  activeCount(): number {
    return this.data.objectives.filter((o) => this.isActive(o)).length;
  }

  private isActive(o: Objective): boolean {
    return o.enabled && !(o.expiresAt && o.expiresAt <= this.now());
  }

  // ---- control ------------------------------------------------------------------------------

  /** Reject anything that is not an allowlisted, enabled READ_ONLY tool. Runs at creation and before every run. */
  validateChecks(checks: ObjectiveCheck[]): void {
    if (!checks.length)
      throw new ObjectiveError("Een doel heeft controles nodig.");
    const registry = new Map(this.tools.list().map((t) => [t.name, t]));
    for (const c of checks) {
      const info = registry.get(c.tool);
      if (!CHECK_TOOLS.has(c.tool) || !info)
        throw new ObjectiveError(
          `De tool ${c.tool} mag niet voor bewaking worden gebruikt.`,
        );
      if (info.risk !== "READ_ONLY")
        throw new ObjectiveError(
          `Bewaking mag alleen lezende tools gebruiken (${c.tool} is dat niet).`,
        );
      if (!info.enabled)
        throw new ObjectiveError(
          `De bron voor ${c.tool} is nu niet beschikbaar.`,
        );
    }
  }

  create(input: CreateInput): { objective: Objective; duplicate: boolean } {
    const title = sanitize(
      typeof input.title === "string" ? input.title : "",
    ).trim();
    if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax)
      throw new ObjectiveError(
        `Beschrijf het doel in ${LIMITS.titleMin} tot ${LIMITS.titleMax} tekens.`,
      );
    const name = typeof input.template === "string" ? input.template : "";
    const template = Object.hasOwn(TEMPLATES, name)
      ? TEMPLATES[name]
      : undefined;
    if (!template)
      throw new ObjectiveError(
        `Onbekend sjabloon. Kies: ${Object.keys(TEMPLATES).join(", ")}.`,
      );
    const kind: ObjectiveKind =
      input.kind === "followup" || input.kind === "monitor"
        ? input.kind
        : template.defaultKind;
    const built = template.build(input.params ?? {});
    this.validateChecks(built.checks);
    const duplicate = this.data.objectives.find(
      (o) =>
        o.enabled &&
        o.template === name &&
        o.kind === kind &&
        JSON.stringify(o.params) === JSON.stringify(built.params),
    );
    if (duplicate) return { objective: duplicate, duplicate: true };
    if (this.data.objectives.length >= LIMITS.maxTotal)
      throw new ObjectiveError(
        "Er zijn al te veel doelen opgeslagen; verwijder er eerst een.",
      );
    if (this.activeCount() >= LIMITS.maxActive)
      throw new ObjectiveError(
        `Er zijn al ${LIMITS.maxActive} actieve doelen; zet er een op pauze of verwijder er een.`,
      );
    const now = this.now();
    const objective: Objective = {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      kind,
      template: name,
      params: built.params,
      checks: built.checks,
      intervalMinutes: this.interval(
        input.intervalMinutes,
        template.defaultInterval,
      ),
      quiet: { ...DEFAULT_QUIET },
      cooldownMinutes: this.cooldown(
        input.cooldownMinutes,
        LIMITS.defaultCooldown,
      ),
      enabled: true,
      createdAt: now,
      expiresAt: this.expiry(input.expiresInDays, now),
      history: [],
      anomalyLog: [],
      counters: {
        checks: 0,
        anomalies: 0,
        falseAlarms: 0,
        notifications: 0,
        suppressed: 0,
        investigations: 0,
      },
    };
    this.data.objectives.push(objective);
    this.save();
    this.record("created", { objective: objective.id, template: name });
    return { objective, duplicate: false };
  }

  update(id: string, patch: UpdateInput): Objective {
    const o = this.get(id);
    if (patch.title !== undefined) {
      const title = sanitize(
        typeof patch.title === "string" ? patch.title : "",
      ).trim();
      if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax)
        throw new ObjectiveError("Ongeldige titel.");
      o.title = title;
    }
    if (patch.intervalMinutes !== undefined)
      o.intervalMinutes = this.interval(
        patch.intervalMinutes,
        o.intervalMinutes,
      );
    if (patch.cooldownMinutes !== undefined)
      o.cooldownMinutes = this.cooldown(
        patch.cooldownMinutes,
        o.cooldownMinutes,
      );
    if (patch.expiresInDays !== undefined)
      o.expiresAt = this.expiry(patch.expiresInDays, this.now());
    if (patch.quietHours !== undefined)
      o.quiet = this.quietPatch(o, patch.quietHours);
    if (typeof patch.enabled === "boolean" && patch.enabled !== o.enabled) {
      if (patch.enabled) {
        if (this.activeCount() >= LIMITS.maxActive)
          throw new ObjectiveError(
            `Er zijn al ${LIMITS.maxActive} actieve doelen.`,
          );
        if (o.expiresAt && o.expiresAt <= this.now()) o.expiresAt = undefined;
        o.fulfilledAt = undefined;
        this.validateChecks(o.checks);
      }
      o.enabled = patch.enabled;
    }
    if (patch.dismiss === true) {
      if (!o.active)
        throw new ObjectiveError("Er is nu geen storing om af te wijzen.");
      if (!o.active.dismissed) {
        o.active.dismissed = true;
        o.counters.falseAlarms++;
        if (o.kind === "followup") o.enabled = false;
      }
    }
    this.save();
    this.record("updated", { objective: o.id });
    return o;
  }

  remove(id: string): Objective {
    const o = this.get(id);
    this.data.objectives.splice(this.data.objectives.indexOf(o), 1);
    this.save();
    this.record("deleted", { objective: id });
    return o;
  }

  private interval(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < LIMITS.minInterval || n > LIMITS.maxInterval)
      throw new ObjectiveError(
        `Het interval ligt tussen ${LIMITS.minInterval} en ${LIMITS.maxInterval} minuten.`,
      );
    return Math.round(n);
  }
  private cooldown(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > LIMITS.maxCooldown)
      throw new ObjectiveError("Ongeldige wachttijd tussen meldingen.");
    return Math.round(n);
  }
  private expiry(value: unknown, now: number): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > LIMITS.maxExpiryDays)
      throw new ObjectiveError("Ongeldige looptijd.");
    return now + Math.round(n) * DAY;
  }
  private quietPatch(o: Objective, value: unknown): Objective["quiet"] {
    if (value === "uit" || value === false)
      return { ...o.quiet, enabled: false };
    if (value === "aan" || value === "standaard" || value === true)
      return { ...DEFAULT_QUIET };
    const m =
      typeof value === "string"
        ? /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(value)
        : null;
    if (!m || parseClock(m[1]!) === null || parseClock(m[2]!) === null)
      throw new ObjectiveError(
        "Stille uren: 'uit', 'aan' of bijvoorbeeld '23:00-07:00'.",
      );
    return { ...o.quiet, enabled: true, start: m[1]!, end: m[2]! };
  }

  // ---- the runner ---------------------------------------------------------------------------

  isDue(o: Objective): boolean {
    if (!this.isActive(o)) return false;
    if (o.lastCheckAt === undefined) return true;
    const next = o.lastCheckAt + o.intervalMinutes * 60_000;
    // A clock that went backwards must not freeze an objective.
    return (
      this.now() >= next ||
      o.lastCheckAt > this.now() + o.intervalMinutes * 60_000
    );
  }

  /** One scheduler round; awaitable for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const o of [...this.data.objectives]) {
        if (o.enabled && o.expiresAt && o.expiresAt <= this.now()) {
          o.enabled = false;
          this.remember(o, "verlopen", "Looptijd verlopen; doel gepauzeerd.");
          this.trySave();
          continue;
        }
        if (this.isDue(o) && !this.inflight.has(o.id)) await this.run(o);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Run the checks of one objective now. */
  async run(o: Objective): Promise<void> {
    this.inflight.add(o.id);
    try {
      o.lastCheckAt = this.now();
      o.counters.checks++;
      try {
        this.validateChecks(o.checks);
      } catch (error) {
        o.enabled = false;
        this.remember(o, "fout", (error as Error).message);
        return this.trySave();
      }
      for (const c of o.checks) await this.runCheck(o, c);
      this.settle(o);
      this.trySave();
    } finally {
      this.inflight.delete(o.id);
    }
  }

  private async runCheck(o: Objective, c: ObjectiveCheck): Promise<void> {
    let result;
    try {
      result = await this.tools.execute(
        c.tool,
        c.args,
        `objective_${o.id}`,
        null,
        false,
        {
          readOnlyOnly: true,
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      result = { ok: false } as { ok: boolean; result?: unknown };
    }
    if (!result.ok) {
      c.state.errors++;
      if (c.state.errors < LIMITS.errorsBeforeAnomaly) return;
      c.state.active = true;
      c.state.detail = "de controle zelf mislukt";
      return;
    }
    c.state.errors = 0;
    const outcome = evaluate(c.condition, result.result);
    c.state.consecutive = outcome.anomaly ? c.state.consecutive + 1 : 0;
    c.state.active = outcome.anomaly && c.state.consecutive >= c.needed;
    c.state.detail = outcome.anomaly ? outcome.detail : undefined;
  }

  /** Compare with the previous situation and alert on transitions only. */
  private settle(o: Objective): void {
    const active = o.checks.filter((c) => c.state.active);
    const now = this.now();
    if (!active.length) {
      if (o.active) {
        const was = o.active;
        o.active = undefined;
        this.remember(
          o,
          "ok",
          "Hersteld.",
          was.notified ? undefined : "niet gemeld",
        );
        if (was.notified && !was.dismissed)
          this.deliver(
            o,
            "info",
            `Hersteld: ${o.title}`,
            "Alles is weer in orde.",
            "recovery",
          );
        return;
      }
      return this.remember(o, "ok", "Alles in orde.");
    }
    const signature = active
      .map((c) => c.id)
      .sort()
      .join(",");
    const urgency = active.reduce<Urgency>(
      (max, c) =>
        URGENCY_RANK[c.urgency] > URGENCY_RANK[max] ? c.urgency : max,
      "info",
    );
    const detail = short(
      active
        .map((c) => `${c.label}${c.state.detail ? ` (${c.state.detail})` : ""}`)
        .join("; "),
      220,
    );
    const changed = !o.active || o.active.signature !== signature;
    if (changed) {
      o.active = {
        signature,
        since: o.active?.since ?? now,
        urgency,
        detail,
        notified: false,
        dismissed: false,
      };
      o.counters.anomalies++;
      o.anomalyLog = [...o.anomalyLog, now].slice(-LIMITS.anomalyLog);
    } else {
      o.active!.detail = detail;
    }
    const state = o.active!;
    if (state.dismissed) return this.remember(o, "anomalie", detail, "gedempt");
    let delivery: string | undefined;
    if (!state.notified) {
      delivery = this.deliver(
        o,
        urgency,
        `Let op: ${o.title}`,
        detail,
        "anomaly",
        !changed,
      );
    }
    this.remember(
      o,
      "anomalie",
      detail,
      delivery ?? (state.notified ? "gemeld" : undefined),
    );
    if (changed && o.kind === "monitor" && urgency !== "info")
      this.investigate(o, state);
    if (o.kind === "followup" && state.notified) {
      o.enabled = false;
      o.fulfilledAt = now;
    }
  }

  // ---- notifications ------------------------------------------------------------------------

  private gate(
    o: Objective,
    urgency: Urgency,
    kind: "anomaly" | "recovery" | "report",
  ): Gate {
    const now = this.now();
    const day = localDay(now, o.quiet.timezone);
    if (this.data.usage.day !== day)
      this.data.usage = { day, notifications: 0 };
    const budget = this.data.settings.dailyBudget;
    const cap = urgency === "urgent" ? budget * 2 : budget;
    if (this.data.usage.notifications >= cap) return "budget";
    if (urgency !== "urgent" && inQuietHours(now, o.quiet)) return "stil";
    if (
      kind === "anomaly" &&
      urgency !== "urgent" &&
      o.lastNotifiedAt !== undefined &&
      now - o.lastNotifiedAt < o.cooldownMinutes * 60_000
    )
      return "cooldown";
    return "ok";
  }

  /** Send at most one alert, if the gates allow it. Returns what happened. */
  private deliver(
    o: Objective,
    urgency: Urgency,
    title: string,
    detail: string,
    kind: "anomaly" | "recovery" | "report",
    retry = false,
  ): string {
    const gate = this.gate(o, urgency, kind);
    if (gate !== "ok") {
      if (!retry) o.counters.suppressed++;
      return gate;
    }
    const now = this.now();
    this.data.usage.notifications++;
    o.lastNotifiedAt = now;
    o.counters.notifications++;
    if (kind === "anomaly" && o.active) o.active.notified = true;
    try {
      this.events.emit({
        topic: "jarvis/alerts",
        payload: {
          type: "alert",
          id: crypto.randomBytes(4).toString("hex"),
          key: `objective-${o.id}`,
          severity: SEVERITY[urgency],
          title: title.slice(0, 120),
          detail: detail.slice(0, 400),
          at: new Date(now).toISOString(),
        },
      } as never);
    } catch {
      this.log.warn("notification failed");
    }
    return "gemeld";
  }

  // ---- investigation ------------------------------------------------------------------------

  private investigate(o: Objective, anomaly: ActiveAnomaly): void {
    const now = this.now();
    if (
      o.lastInvestigationAt !== undefined &&
      now - o.lastInvestigationAt < LIMITS.investigationCooldownMinutes * 60_000
    )
      return;
    // Set before the call: even a failed start counts, so a broken agent is not hammered.
    o.lastInvestigationAt = now;
    try {
      const run = this.agent.start(
        short(
          `onderzoek waarom ${o.title}: ${anomaly.detail}. Alleen lezen en onderzoeken: gebruik uitsluitend lezende tools, wijzig niets, vraag geen toestemming en start geen nieuwe taken of doelen.`,
          580,
        ),
        {
          maxTurns: LIMITS.investigationTurns,
          minutes: LIMITS.investigationMinutes,
          readOnly: true,
        },
      );
      o.counters.investigations++;
      o.lastInvestigation = { runId: run.id, at: now };
      void this.attach(o.id, run.id);
    } catch (error) {
      this.log.warn(`investigation not started: ${(error as Error).message}`);
    }
  }

  /** Wait for the investigation and attach its KLAAR summary to the objective and the alert feed. */
  private async attach(objectiveId: string, runId: string): Promise<void> {
    for (let i = 0; i < this.investigationPollLimit; i++) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.pollMs);
        t.unref?.();
      });
      let run;
      try {
        run = this.agent.get(runId);
      } catch {
        return;
      }
      if (run.status === "running" || run.status === "waiting") continue;
      const o = this.data.objectives.find((x) => x.id === objectiveId);
      if (!o || o.lastInvestigation?.runId !== runId) return;
      const summary = short(run.result ?? "Geen uitkomst.", 400);
      o.lastInvestigation.summary = summary;
      if (run.status === "done" && o.active && !o.active.dismissed) {
        o.active.detail = short(
          `${o.active.detail} | Onderzoek: ${summary}`,
          600,
        );
        this.deliver(
          o,
          o.active.urgency,
          `Onderzoek: ${o.title}`,
          summary,
          "report",
        );
      }
      this.trySave();
      return;
    }
  }

  // ---- housekeeping -------------------------------------------------------------------------

  private remember(
    o: Objective,
    status: ResultStatus,
    summary: string,
    delivery?: string,
  ): void {
    const at = this.now();
    o.lastResult = { at, status, summary: short(summary, 240) };
    o.history = [
      ...o.history,
      { at, status, summary: short(summary, 160), delivery },
    ].slice(-LIMITS.history);
  }
  private save(): void {
    this.store.save(this.data);
  }
  private trySave(): void {
    try {
      this.save();
    } catch {
      /* memory stays authoritative until the next change */
    }
  }
  /** Only metadata is audited. */
  private record(phase: string, extra: Record<string, unknown>): void {
    try {
      this.audit.record({
        sessionId: "objectives",
        tool: "objective",
        phase,
        ...extra,
      });
    } catch {
      /* the audit log must not stop an objective */
    }
  }
}
