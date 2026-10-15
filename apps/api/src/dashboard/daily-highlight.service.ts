import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { ScheduledAttemptBudget } from "./scheduled-attempt-budget.js";

const CHECK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
/** Fixed, non-identifying copy only; never send a day's private conversation to a model. */
function safeHighlight(content: string): string | null {
  const text = content.slice(0, 500).trim();
  if (
    !text ||
    text.includes("?") ||
    /\b(?:niet|nooit|geen|misschien|als|wanneer|zou|had)\b/i.test(text)
  )
    return null;
  if (
    /^(?:ik heb|vandaag heb ik)\b.{0,80}\b(?:mijn|een|het) project\b.{0,80}\b(?:afgerond|voltooid)\b/i.test(
      text,
    )
  )
    return "Je rondde vandaag een project af.";
  if (
    /^(?:ik heb|vandaag heb ik)\b.{0,80}\b(?:mijn|een|de) (?:taak|klus)\b.{0,80}\b(?:afgerond|voltooid)\b/i.test(
      text,
    )
  )
    return "Je rondde vandaag een taak af.";
  if (
    /^(?:ik heb|vandaag heb ik)\b.{0,80}\b(?:mijn|een|het) examen\b.{0,80}\bgehaald\b/i.test(
      text,
    )
  )
    return "Je haalde vandaag een examen.";
  if (/^(?:vandaag )?(?:het is me|het is mij) gelukt\b/i.test(text))
    return "Iets waar je mee bezig was, is vandaag gelukt.";
  if (/^(?:ik heb|vandaag heb ik)\b.{0,80}\bleuk gehad\b/i.test(text))
    return "Je vertelde vandaag over een leuk moment.";
  return null;
}

function localDayAndTime(
  date: Date,
  timezone: string,
): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

const EVENT_HIGHLIGHTS = {
  code_run_tests: "De controles van een codeproject zijn vandaag geslaagd.",
  code_self_test: "De controles van een codeproject zijn vandaag geslaagd.",
  node_red_flow_create:
    "Er is vandaag een nieuwe automatisering voor je aangemaakt.",
} as const;

function auditTime(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    return null;
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Opt-in daily highlight from explicit positive statements or verified useful actions. */
@Injectable()
export class DailyHighlightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyHighlightService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = false;
  private lastAttemptAt = 0;
  private readonly attempts: ScheduledAttemptBudget;

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly session: SessionMemoryService,
    private readonly alerts: AlertsFeed,
    private readonly audit: AuditService,
  ) {
    this.progressFile = config.dataFile("daily-highlight-progress.json");
    this.attempts = new ScheduledAttemptBudget(
      config.dataFile("daily-highlight-attempts.json"),
    );
  }

  onModuleInit(): void {
    void this.checkSchedule();
    this.timer = setInterval(() => void this.checkSchedule(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async checkSchedule(now = new Date()): Promise<void> {
    if (this.running || this.paused) return;
    const preference = normalizeHelperPreferences(
      this.settings.get().helperPreferences as unknown as Record<
        string,
        unknown
      >,
    ).rituals?.dailyHighlight;
    if (!preference?.enabled) return;
    const { day, time } = localDayAndTime(now, this.config.timezone);
    if (time < preference.time) return;
    const completed = this.completedDay();
    if (this.paused || completed === day) return;
    if (now.getTime() - this.lastAttemptAt < RETRY_MS) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const workflowId = `nova-workflow:${crypto.createHash("sha256").update(`nova:daily-highlight:${day}`).digest("hex")}`;
      if (this.alerts.findWorkflowEvent(workflowId)) {
        this.saveCompletedDay(day);
        return;
      }
      if (!this.attempts.reserve(day, now.getTime())) return;
      this.lastAttemptAt = now.getTime();
      const done = await this.createHighlight(day, now, workflowId);
      if (done) this.saveCompletedDay(day);
      try {
        this.audit.record({
          tool: "proactive_daily_highlight",
          risk: "READ_ONLY",
          phase: done ? "completed" : "skipped",
          durationMs: Date.now() - startedAt,
          arguments: { day },
          result: { ok: done },
        });
      } catch {
        this.logger.warn("Daily highlight audit unavailable");
      }
    } catch {
      this.lastAttemptAt = now.getTime();
      try {
        this.audit.record({
          tool: "proactive_daily_highlight",
          risk: "READ_ONLY",
          phase: "failed",
          durationMs: Date.now() - startedAt,
          arguments: { day },
          result: { ok: false },
        });
      } catch {
        this.logger.warn("Daily highlight audit unavailable");
      }
      this.logger.warn("Daily highlight unavailable; retry scheduled");
    } finally {
      this.running = false;
    }
  }

  private completedDay(): string | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.progressFile, "utf8")) as {
        completedDay?: unknown;
      };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value?.completedDay ?? "")))
        throw new Error("Invalid daily highlight progress");
      return value.completedDay as string;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.paused = true;
      this.logger.error("Daily highlight progress unreadable; schedule paused");
      return null;
    }
  }

  private saveCompletedDay(day: string): void {
    try {
      const temporary = `${this.progressFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ completedDay: day }), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const descriptor = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.progressFile);
      const directory = fs.openSync(path.dirname(this.progressFile), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      this.paused = true;
      this.logger.error(
        "Daily highlight progress could not be saved; schedule paused",
      );
    }
  }

  private verifiedEventHighlight(day: string, now: Date): string | null {
    // Read failures propagate to the existing bounded retry path, never complete an unread day.
    const entries = this.audit.read(500);
    if (!Array.isArray(entries)) throw new Error("Daily activity unavailable");
    let latest = -Infinity;
    let detail: string | null = null;
    for (const entry of entries.slice(0, 500)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.tool !== "string" ||
        !Object.hasOwn(EVENT_HIGHLIGHTS, entry.tool) ||
        entry.risk !== "DANGEROUS" ||
        entry.confirmation !== "confirmed" ||
        entry.verification !== true ||
        (entry.phase !== undefined &&
          entry.phase !== "completed" &&
          entry.phase !== "verified")
      )
        continue;
      const result = entry.result;
      if (!result || typeof result !== "object" || Array.isArray(result))
        continue;
      const evidence = result as Record<string, unknown>;
      if (
        evidence.ok !== true ||
        evidence.verified !== true ||
        evidence.error != null ||
        evidence.executed === false ||
        evidence.accepted === true ||
        evidence.requiresConfirmation === true ||
        evidence.pendingConfirmation === true ||
        evidence.status != null
      )
        continue;
      const timestamp = auditTime(entry.timestamp);
      if (
        timestamp === null ||
        timestamp > now.getTime() ||
        timestamp <= latest ||
        localDayAndTime(new Date(timestamp), this.config.timezone).day !== day
      )
        continue;
      latest = timestamp;
      detail = EVENT_HIGHLIGHTS[entry.tool as keyof typeof EVENT_HIGHLIGHTS];
    }
    return detail;
  }

  private createHighlight(day: string, now: Date, workflowId: string): boolean {
    const detail =
      this.session
        .allMessages()
        .filter(
          (message) =>
            message.role === "user" &&
            Number.isFinite(Date.parse(message.at)) &&
            localDayAndTime(new Date(message.at), this.config.timezone).day ===
              day,
        )
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-100)
        .reverse()
        .map((message) => safeHighlight(message.content))
        .find((copy) => copy !== null) ?? this.verifiedEventHighlight(day, now);
    if (!detail) return true;
    const accepted = this.alerts.record(
      {
        topic: "jarvis/alerts",
        payload: {
          title: "Hoogtepunt van vandaag",
          detail,
          severity: "info",
          key: `daily-highlight-${day}`,
          at: now.toISOString(),
        },
      },
      now,
      workflowId,
    );
    return accepted !== null;
  }
}
