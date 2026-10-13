import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { AlertsFeed } from "./alerts-feed.service.js";

const CHECK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
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

/** Opt-in, once-a-day highlight based only on explicit positive user statements. */
@Injectable()
export class DailyHighlightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyHighlightService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = false;
  private lastAttemptAt = 0;
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly session: SessionMemoryService,
    private readonly alerts: AlertsFeed,
    private readonly audit: AuditService,
  ) {
    this.progressFile = config.dataFile("daily-highlight-progress.json");
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
    if (time < preference.time || this.completedDay() === day) return;
    const attempts = this.attempts.get(day) ?? 0;
    if (
      attempts >= MAX_ATTEMPTS ||
      now.getTime() - this.lastAttemptAt < RETRY_MS
    )
      return;
    this.running = true;
    this.lastAttemptAt = now.getTime();
    this.attempts.set(day, attempts + 1);
    const startedAt = Date.now();
    try {
      const done = await this.createHighlight(day, now);
      this.audit.record({
        tool: "proactive_daily_highlight",
        risk: "READ_ONLY",
        phase: done ? "completed" : "skipped",
        durationMs: Date.now() - startedAt,
        arguments: { day },
        result: { ok: done },
      });
      if (done) this.saveCompletedDay(day);
    } catch {
      this.audit.record({
        tool: "proactive_daily_highlight",
        risk: "READ_ONLY",
        phase: "failed",
        durationMs: Date.now() - startedAt,
        arguments: { day },
        result: { ok: false },
      });
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
      return typeof value.completedDay === "string" ? value.completedDay : null;
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
      fs.renameSync(temporary, this.progressFile);
      this.attempts.delete(day);
    } catch {
      this.paused = true;
      this.logger.error(
        "Daily highlight progress could not be saved; schedule paused",
      );
    }
  }

  private createHighlight(day: string, now: Date): boolean {
    const detail = this.session
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
      .find((copy) => copy !== null);
    if (!detail) return true;
    this.alerts.record(
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
    );
    return true;
  }
}
