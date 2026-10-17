import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentService } from "../agent/agent.service.js";
import { AgentError } from "../agent/agent.types.js";
import { type DirectGoal, DELEGATION_REPLY } from "../chat/direct-goal.js";
import { OrchestratorService } from "../chat/orchestrator.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { McpHub } from "../integrations/mcp/mcp.hub.js";
import { ObjectivesService } from "../objectives/objectives.service.js";
import { inQuietHours, localDay } from "../objectives/objectives.time.js";
import { ObjectiveError } from "../objectives/objectives.types.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { ModelMetricsService } from "../routing/model-metrics.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { TelephonyService } from "../telephony/telephony.service.js";
import { allowsAutoApproval } from "../tools/autonomy-policy.js";
import { AutonomyLevelStore } from "../tools/autonomy-level.store.js";
import { ToolsService } from "../tools/tools.service.js";
import { applySettings, AutopilotStore } from "./autopilot.store.js";
import {
  runScan,
  type ReadTools,
  type ScanContext,
} from "./autopilot.scans.js";
import { T } from "./autopilot.templates.js";
import {
  LIMITS,
  SCAN_NAMES,
  type ActivityEntry,
  type AutopilotFile,
  type AutopilotSettings,
  type Finding,
  type Urgency,
} from "./autopilot.types.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const RANK: Record<Urgency, number> = { info: 0, warn: 1, urgent: 2 };
const SEVERITY = { info: "info", warn: "warning", urgent: "critical" } as const;
const KEY_SERVICES = /omni|mqtt|qdrant|speech|stt|tts|home/i;
const AGENT_SESSION = "autopilot";

export type Outcome = "gemeld" | "cooldown" | "stil" | "budget" | "limiet";

/**
 * The always-on autopilot: every few minutes it runs deterministic read-only scans (no model call), turns what it finds into
 * short Dutch messages from templates and delivers them as initiative: the alert feed, a Linphone text to saved contacts and,
 * only when allowed, a phone call for something urgent. Quiet hours, a daily budget, an hourly limit and per-finding cooldowns
 * keep it from nagging. See docs/autopilot.md.
 */
@Injectable()
export class AutopilotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("NOVA autopilot");
  private data!: AutopilotFile;
  private loaded = false;
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private readonly healAttempts = new Map<string, number>();
  private readonly noted = new Map<string, string>();
  /** Replaceable in tests. */
  now: () => number = Date.now;
  tickMs = 30_000;
  /** First scan after a fresh start. */
  firstScanDelayMs = 45_000;

  constructor(
    private readonly store: AutopilotStore,
    private readonly tools: ToolsService,
    private readonly events: JarvisStateStore,
    private readonly objectives: ObjectivesService,
    private readonly agent: AgentService,
    private readonly autonomy: AutonomyLevelStore,
    private readonly audit: AuditService,
    private readonly config: NovaConfig,
    @Optional() private readonly telephony?: TelephonyService,
    @Optional() private readonly routing?: RoutingService,
    @Optional() private readonly metrics?: ModelMetricsService,
    @Optional() private readonly mcp?: McpHub,
    @Optional() private readonly home?: HomeAssistantService,
    @Optional() private readonly orchestrator?: OrchestratorService,
  ) {}

  onModuleInit(): void {
    this.recover();
    this.orchestrator?.setGoalDelegator((goal, context) =>
      this.delegate(goal, context),
    );
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.orchestrator?.setGoalDelegator(undefined);
  }

  /** Reload from disk. The due time is the stored one, so a restart resumes instead of scanning in a burst. */
  recover(): void {
    this.data = this.store.load();
    this.loaded = true;
    if (!this.data.nextDueAt) {
      this.data.nextDueAt = this.now() + this.firstScanDelayMs;
      this.trySave();
    }
  }

  private get file(): AutopilotFile {
    if (!this.loaded) this.recover();
    return this.data;
  }

  get settings(): AutopilotSettings {
    return this.file.settings;
  }

  // ---- settings and views ---------------------------------------------------------------------

  updateSettings(patch: unknown): AutopilotSettings {
    const file = this.file;
    const before = file.settings.enabled;
    file.settings = applySettings(file.settings, patch);
    if (file.settings.enabled && !before)
      file.nextDueAt = Math.min(
        file.nextDueAt,
        this.now() + this.firstScanDelayMs,
      );
    this.record({
      kind: "setting",
      outcome:
        before === file.settings.enabled
          ? "bijgewerkt"
          : file.settings.enabled
            ? "aan"
            : "uit",
    });
    this.save();
    return structuredClone(file.settings);
  }

  setEnabled(enabled: boolean): AutopilotSettings {
    return this.updateSettings({ enabled });
  }

  status() {
    const file = this.file;
    const now = this.now();
    this.rollDay(now);
    const hourly = file.recentSends.filter((t) => t > now - HOUR).length;
    return {
      enabled: file.settings.enabled,
      lastScanAt: file.lastScanAt
        ? new Date(file.lastScanAt).toISOString()
        : null,
      nextDueAt: file.settings.enabled
        ? new Date(file.nextDueAt).toISOString()
        : null,
      intervalMinutes: file.settings.intervalMinutes,
      initiativesToday: file.usage.count,
      dailyBudget: file.settings.dailyBudget,
      initiativesLastHour: hourly,
      hourlyLimit: file.settings.hourlyLimit,
      quietNow: inQuietHours(now, file.settings.quiet),
      standingObjectivesBootstrapped: file.bootstrapped,
      findings: file.lastFindings.map((f) => ({
        ...f,
        at: new Date(f.at).toISOString(),
      })),
      activity: file.activity.slice(-30).map(describeActivity),
    };
  }

  activity() {
    return this.file.activity.map(describeActivity);
  }

  // ---- scheduler ------------------------------------------------------------------------------

  async tick(): Promise<void> {
    const file = this.file;
    if (!file.settings.enabled || this.scanning) return;
    if (this.now() < file.nextDueAt) return;
    await this.scan();
  }

  /** One full round of scans and deliveries; awaitable for tests and the "scan now" button. */
  async scan(): Promise<{ findings: number; delivered: number }> {
    if (this.scanning) return { findings: 0, delivered: 0 };
    this.scanning = true;
    const file = this.file;
    let findings = 0;
    let delivered = 0;
    try {
      const now = this.now();
      this.rollDay(now);
      this.prune(now);
      // Set before the work: a crash in the middle must not turn into a scan storm after restart.
      file.nextDueAt = now + file.settings.intervalMinutes * MIN;
      file.lastScanAt = now;
      this.trySave();
      await this.bootstrap();
      const ctx = this.context(now);
      const all: Finding[] = [];
      for (const name of SCAN_NAMES) {
        if (!file.settings.scans[name]) continue;
        try {
          const found = await runScan(name, ctx);
          all.push(...found);
          this.record({
            kind: "scan",
            scan: name,
            outcome: `${found.length} bevindingen`,
          });
        } catch {
          this.record({ kind: "scan", scan: name, outcome: "fout" });
        }
      }
      const summaries: AutopilotFile["lastFindings"] = [];
      for (const f of all) {
        findings++;
        const outcome = await this.deliver(f);
        if (outcome === "gemeld") delivered++;
        summaries.push({
          id: f.id,
          scan: f.scan,
          urgency: f.urgency,
          title: f.title,
          at: now,
          outcome,
        });
      }
      file.lastFindings = summaries.slice(-LIMITS.findings);
    } finally {
      this.scanning = false;
      this.trySave();
    }
    return { findings, delivered };
  }

  private context(now: number): ScanContext {
    const file = this.file;
    return {
      now,
      settings: file.settings,
      timezone: this.config.timezone,
      misses: file.homeMisses,
      healAttempts: this.healAttempts,
      ports: {
        tools: this.readTools(),
        routing: this.routing,
        metrics: this.metrics,
        mcp: this.mcp,
        telephony: this.telephony
          ? {
              enabled: this.telephony.enabled,
              textReady: () => this.telephony!.textReady(),
            }
          : undefined,
        home: this.home,
        agent: this.agent,
        objectives: this.objectives,
        system: {
          diskFreePercent: () => this.diskFree(),
          memoryFreePercent: () => this.memoryFree(),
        },
        healed: (note) => this.record({ kind: "heal", outcome: note }),
      },
    };
  }

  private readTools(): ReadTools {
    const has = (name: string) =>
      this.tools
        .list()
        .some((t) => t.name === name && t.enabled && t.risk === "READ_ONLY");
    return {
      has,
      read: async (name, args = {}) => {
        if (!has(name)) return null;
        try {
          return await this.tools.execute(
            name,
            args,
            AGENT_SESSION,
            null,
            false,
            {
              readOnlyOnly: true,
              signal: AbortSignal.timeout(20_000),
            },
          );
        } catch {
          return { ok: false };
        }
      },
    };
  }

  private async diskFree(): Promise<number | null> {
    try {
      const s = await fs.promises.statfs(path.dirname(this.store.file));
      return s.blocks > 0 ? (Number(s.bavail) / Number(s.blocks)) * 100 : null;
    } catch {
      return null;
    }
  }

  private memoryFree(): number | null {
    try {
      const text = fs.readFileSync("/proc/meminfo", "utf8");
      const total = Number(/MemTotal:\s+(\d+)/.exec(text)?.[1]);
      const free = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1]);
      return total > 0 && Number.isFinite(free) ? (free / total) * 100 : null;
    } catch {
      return null;
    }
  }

  // ---- delivery -------------------------------------------------------------------------------

  /** Decide whether a finding may be announced now, and announce it. Returns what happened. */
  async deliver(f: Finding): Promise<Outcome> {
    const file = this.file;
    const s = file.settings;
    const now = this.now();
    this.rollDay(now);
    const last = file.sent[f.key];
    if (last !== undefined && now - last < f.cooldownMinutes * MIN)
      return "cooldown";
    const urgent = f.urgency === "urgent";
    const cap = (n: number) => (urgent ? n * 2 : n);
    if (file.usage.count >= cap(s.dailyBudget)) return this.hold(f, "budget");
    const hourly = file.recentSends.filter((t) => t > now - HOUR).length;
    if (hourly >= cap(s.hourlyLimit)) return this.hold(f, "limiet");
    const quiet = inQuietHours(now, s.quiet);
    // Quiet hours hold back everything except urgent; the finding comes back with the next scan if it still applies.
    if (quiet && !urgent) return this.hold(f, "stil");

    file.usage.count++;
    file.recentSends = [...file.recentSends.filter((t) => t > now - HOUR), now];
    file.sent[f.key] = now;
    this.noted.delete(f.key);
    this.emitAlert(f, now);
    this.record({
      kind: "finding",
      scan: f.scan,
      urgency: f.urgency,
      findingId: f.id,
      outcome: "gemeld",
    });
    this.trySave();
    await this.sendTexts(f);
    if (urgent && !quiet) await this.maybeCall(f);
    this.trySave();
    return "gemeld";
  }

  private hold(f: Finding, outcome: Outcome): Outcome {
    // Note a held finding once per reason, so the log shows the decision without a line every five minutes.
    if (this.noted.get(f.key) !== outcome) {
      this.noted.set(f.key, outcome);
      this.record({
        kind: "suppressed",
        scan: f.scan,
        urgency: f.urgency,
        findingId: f.id,
        outcome,
      });
    }
    return outcome;
  }

  private emitAlert(f: Finding, now: number): void {
    try {
      this.events.emit({
        topic: "jarvis/alerts",
        payload: {
          type: "alert",
          id: crypto.randomBytes(4).toString("hex"),
          key: `autopilot-${f.key}`.slice(0, 80),
          severity: SEVERITY[f.urgency],
          title: f.title.slice(0, 120),
          detail: f.detail.slice(0, 400),
          at: new Date(now).toISOString(),
        },
      } as never);
    } catch {
      this.log.warn("alert not delivered");
    }
  }

  private async sendTexts(f: Finding): Promise<void> {
    const s = this.settings;
    if (!s.textContacts || !this.telephony) return;
    if (RANK[f.urgency] < RANK[s.textMinUrgency]) return;
    if (!this.telephony.enabled) return;
    const ready = await this.telephony.textReady();
    if (!ready.ready) {
      this.record({
        kind: "text",
        findingId: f.id,
        outcome: "niet beschikbaar",
      });
      return;
    }
    const body = T.text(f.title, f.detail);
    for (const name of this.telephony.conversationContacts()) {
      try {
        await this.telephony.sendText(name, body);
        this.record({ kind: "text", findingId: f.id, outcome: "verstuurd" });
      } catch {
        this.record({ kind: "text", findingId: f.id, outcome: "mislukt" });
      }
    }
  }

  /** A call needs three yeses: the setting, an autonomy level that lets NOVA call by herself, and a working phone system. */
  private async maybeCall(f: Finding): Promise<void> {
    const s = this.settings;
    if (!s.allowCalls || !this.telephony?.enabled) return;
    const allowed = allowsAutoApproval("phone_call", {
      level: this.autonomy.get(),
      routine: true,
      tainted: false,
    });
    if (!allowed) {
      this.record({
        kind: "call",
        findingId: f.id,
        outcome: "autonomieniveau staat het niet toe",
      });
      return;
    }
    const [contact] = this.telephony.conversationContacts();
    if (!contact) return;
    try {
      const result = await this.tools.execute(
        "phone_call",
        { to: contact, message: T.call(f.title) },
        AGENT_SESSION,
        null,
        false,
        { signal: AbortSignal.timeout(30_000) },
      );
      this.record({
        kind: "call",
        findingId: f.id,
        outcome: result.ok
          ? "gebeld"
          : result.requiresConfirmation
            ? "wacht op bevestiging"
            : "mislukt",
      });
    } catch {
      this.record({ kind: "call", findingId: f.id, outcome: "mislukt" });
    }
  }

  // ---- standing objectives --------------------------------------------------------------------

  /** Once, when there are none: watch the servers (if Proxmox is there) or the key local services. Skips what is missing. */
  async bootstrap(): Promise<void> {
    const file = this.file;
    if (file.bootstrapped) return;
    file.bootstrapped = true;
    this.trySave();
    if (this.objectives.list().length > 0) {
      this.record({
        kind: "bootstrap",
        outcome: "overgeslagen: er zijn al doelen",
      });
      return;
    }
    const tools = this.readTools();
    let created = 0;
    const create = (input: Parameters<ObjectivesService["create"]>[0]) => {
      try {
        if (!this.objectives.create(input).duplicate) created++;
      } catch (error) {
        if (!(error instanceof ObjectiveError)) throw error;
      }
    };
    const proxmox = await tools.read("proxmox_status");
    if (proxmox?.ok && tools.has("proxmox_guests")) {
      create({ title: "Houd mijn servers gezond", template: "servers_gezond" });
    } else {
      const names = await tools.read("network_check");
      const results = (
        names?.ok
          ? ((names.result as { results?: unknown })?.results ?? [])
          : []
      ) as { name?: unknown; ok?: unknown }[];
      const wanted = results
        .filter(
          (r) =>
            typeof r.name === "string" &&
            r.ok === true &&
            KEY_SERVICES.test(r.name) &&
            /^[a-z0-9._-]{1,40}$/i.test(r.name),
        )
        .slice(0, 3);
      for (const r of wanted)
        create({
          title: `Houd ${String(r.name)} in de gaten`,
          template: "service_online",
          params: { target: r.name },
        });
    }
    this.record({ kind: "bootstrap", outcome: `${created} doelen gemaakt` });
  }

  // ---- delegation (no model) ------------------------------------------------------------------

  async delegate(
    goal: DirectGoal,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context?: { sessionId: string },
  ): Promise<string | null> {
    try {
      if (goal.kind === "agent") {
        // At the careful level every step is ask-first; the model flow keeps that conversation natural.
        if (this.autonomy.get() === "careful") return null;
        this.agent.start(goal.goal);
        this.record({ kind: "delegated", outcome: "taak gestart" });
        return DELEGATION_REPLY;
      }
      const { duplicate } = this.objectives.create({
        title: goal.title,
        template: goal.template,
        params: goal.params,
      });
      this.record({
        kind: "delegated",
        outcome: duplicate ? "doel bestond al" : "doel gemaakt",
      });
      return duplicate
        ? "Dat houd ik al in de gaten."
        : "Dat houd ik vanaf nu in de gaten en ik meld me als er iets is.";
    } catch (error) {
      if (error instanceof AgentError || error instanceof ObjectiveError)
        return error.message;
      return null;
    }
  }

  // ---- housekeeping ---------------------------------------------------------------------------

  private rollDay(now: number): void {
    const file = this.file;
    const day = localDay(now, file.settings.quiet.timezone);
    if (file.usage.day !== day) file.usage = { day, count: 0 };
  }

  private prune(now: number): void {
    const file = this.file;
    file.recentSends = file.recentSends.filter((t) => t > now - HOUR);
    for (const [key, at] of Object.entries(file.sent))
      if (now - at > LIMITS.sentKeepMs) delete file.sent[key];
  }

  private record(entry: Omit<ActivityEntry, "at">): void {
    const file = this.file;
    file.activity = [...file.activity, { at: this.now(), ...entry }].slice(
      -LIMITS.activity,
    );
    try {
      this.audit.record({
        sessionId: "autopilot",
        tool: "autopilot",
        phase: entry.kind,
        ...(entry.scan ? { scan: entry.scan } : {}),
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
      });
    } catch {
      /* the audit log must not stop the autopilot */
    }
  }

  private save(): void {
    this.store.save(this.file);
  }

  private trySave(): void {
    try {
      this.save();
    } catch {
      /* memory stays authoritative until the next change */
    }
  }
}

function describeActivity(a: ActivityEntry) {
  return { ...a, at: new Date(a.at).toISOString() };
}
