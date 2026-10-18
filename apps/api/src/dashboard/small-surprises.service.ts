import {
  readJsonStateOrEnoent,
  writeJsonState,
} from "../core/db/json-state.js";
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import type { MemoryRecord } from "@nova/contracts";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import { ConversationMilestoneService } from "../memory/conversation-milestone.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { inQuietHours, localParts } from "./rituals.service.js";
import { SpeechPresenceService } from "./speech-presence.service.js";

const CHECK_MS = 60_000;
const OCCASIONS = {
  birthday: { title: "Fijne verjaardag", detail: "Maak er een mooie dag van." },
  newYear: {
    title: "Gelukkig nieuwjaar",
    detail: "Ik wens je een rustig begin van het nieuwe jaar.",
  },
} as const;

// Strict first-person facts only. No inference from summaries, relatives or quoted chat.
function ownBirthday(record: MemoryRecord): string | null {
  if (
    record.source !== "explicit_user" ||
    record.type !== "USER_FACT" ||
    (record.archived !== undefined && record.archived !== false)
  )
    return null;
  const match =
    /^(?:mijn verjaardag is (?:op )?|ik ben geboren op |ik ben jarig op |my birthday is (?:on )?|i was born on )(.+?)[.!]?$/i.exec(
      record.text,
    );
  if (!match) return null;
  const date = match[1]!;
  let year = 2000,
    month: number,
    day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
    if (year < 1 || year > 9999) return null;
  } else {
    const months = [
      "januari|january",
      "februari|february",
      "maart|march",
      "april",
      "mei|may",
      "juni|june",
      "juli|july",
      "augustus|august",
      "september",
      "oktober|october",
      "november",
      "december",
    ];
    const named = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/i.exec(date);
    const english = /^([a-z]+) (\d{1,2})(?:,? (\d{4}))?$/i.exec(date);
    if (!named && !english) return null;
    const name = (named?.[2] ?? english![1]!).toLowerCase();
    month = months.findIndex((names) => names.split("|").includes(name)) + 1;
    day = Number(named?.[1] ?? english![2]);
    if (named?.[3] || english?.[3]) year = Number(named?.[3] ?? english![3]);
    if (year < 1 || year > 9999) return null;
  }
  // setUTCFullYear avoids Date.UTC treating years0–99 as1900–1999.
  const checked = new Date(0);
  checked.setUTCFullYear(year, month - 1, day);
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  )
    return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Sparse opt-in occasions: fixed copy, explicitly saved facts, no chat scanning. */
@Injectable()
export class SmallSurprisesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmallSurprisesService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private paused = false;
  private destroyed = false;
  private memoryCheck: Promise<void> | null = null;

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly alerts: AlertsFeed,
    private readonly presence: SpeechPresenceService,
    @Optional() private readonly milestone?: ConversationMilestoneService,
    @Optional() private readonly memory?: SemanticMemoryService,
  ) {
    this.progressFile = config.dataFile("small-surprises-progress.json");
  }

  onModuleInit(): void {
    this.checkSchedule();
    this.timer = setInterval(() => this.checkSchedule(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
  }

  checkSchedule(now = new Date()): void | Promise<void> {
    if (this.memoryCheck) return this.memoryCheck;
    return this.checkOccasion(now);
  }

  private checkOccasion(
    now: Date,
    memoryBirthday?: string | null,
  ): void | Promise<void> {
    if (this.paused || this.destroyed) return;
    try {
      const preferences = normalizeHelperPreferences(
        this.settings.get().helperPreferences as unknown as Record<
          string,
          unknown
        >,
      );
      if (!preferences.rituals?.smallSurprises.enabled) return;
      const parts = localParts(now, this.config.timezone);
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}`;
      if (time < "09:00" || time >= "20:00") return;
      const quiet = preferences.cues.quiet;
      if (
        (quiet.enabled && inQuietHours(time, quiet.start, quiet.end)) ||
        this.alerts.focusStatus(now).active ||
        this.presence.maySpeak() === false
      )
        return;
      const manualBirthday = preferences.wardrobe?.birthday;
      if (
        !manualBirthday &&
        memoryBirthday === undefined &&
        this.memory?.configured &&
        this.completedDay() !== day &&
        !this.paused
      ) {
        const started = Date.now();
        this.memoryCheck = this.readMemoryBirthday()
          .then((birthday) => {
            // Re-read settings and all delivery gates after asynchronous retrieval.
            this.checkOccasion(
              new Date(now.getTime() + Date.now() - started),
              birthday,
            );
          })
          .catch(() => {
            this.logger.warn("Small surprise schedule unavailable");
          })
          .finally(() => {
            this.memoryCheck = null;
          });
        return this.memoryCheck;
      }
      const occasion =
        (manualBirthday || memoryBirthday) === `${parts.month}-${parts.day}`
          ? "birthday"
          : `${parts.month}-${parts.day}` === "01-01"
            ? "newYear"
            : null;
      if (!occasion) {
        this.deliverMilestone(day, now);
        return;
      }
      if (this.completedDay() === day || this.paused) return;
      // At most once matters more than retrying a non-essential greeting after a crash.
      if (!this.saveCompletedDay(day)) return;
      const copy = OCCASIONS[occasion];
      this.alerts.record(
        {
          topic: "jarvis/alerts",
          payload: {
            title: copy.title,
            detail: copy.detail,
            severity: "info",
            key: `small-surprise-${occasion}`,
            at: now.toISOString(),
          },
        },
        now,
      );
    } catch {
      this.logger.warn("Small surprise schedule unavailable");
    }
  }

  private async readMemoryBirthday(): Promise<string | null> {
    if (!this.memory) return null;
    try {
      let offset: string | number | undefined;
      const cursors = new Set<string>();
      const ids = new Set<string>();
      const birthdays = new Set<string>();
      for (let page = 0; page < 5; page++) {
        const result = await this.memory.list(100, offset);
        if (
          result.unavailable ||
          !Array.isArray(result.memories) ||
          result.memories.length > 100
        )
          return null;
        for (const record of result.memories) {
          if (
            !record ||
            typeof record.id !== "string" ||
            !record.id ||
            ids.has(record.id) ||
            typeof record.text !== "string" ||
            record.text.length > 2000
          )
            return null;
          ids.add(record.id);
          const birthday = ownBirthday(record);
          if (birthday) birthdays.add(birthday);
        }
        const next = result.next;
        if (next === null || next === undefined)
          return birthdays.size === 1 ? ([...birthdays][0] ?? null) : null;
        if (
          (typeof next !== "string" || !next || next.length > 200) &&
          (typeof next !== "number" || !Number.isSafeInteger(next) || next <= 0)
        )
          return null;
        const cursor = `${typeof next}:${next}`;
        if (cursors.has(cursor) || !result.memories.length) return null;
        cursors.add(cursor);
        offset = next;
      }
    } catch {
      // Unavailable memory must not block public occasions or expose private facts in logs.
    }
    return null;
  }

  private deliverMilestone(day: string, now: Date): void {
    if (!this.milestone?.pending()) return;
    const workflowId = `nova-workflow:${crypto.createHash("sha256").update("nova:conversation-milestone:100").digest("hex")}`;
    let accepted = this.alerts.findWorkflowEvent(workflowId);
    if (!accepted) {
      if (this.completedDay() === day || this.paused) return;
      accepted =
        this.alerts.record(
          {
            topic: "jarvis/alerts",
            payload: {
              title: "Honderd chatbeurten",
              detail:
                "We hebben honderd chatbeurten afgerond. Bedankt voor het vertrouwen.",
              severity: "info",
              key: "small-surprise-conversation-100",
              at: now.toISOString(),
            },
          },
          now,
          workflowId,
        ) ?? undefined;
    }
    if (!accepted) return;
    const at = localParts(new Date(accepted.at), this.config.timezone);
    if (
      `${at.year}-${at.month}-${at.day}` === day &&
      !this.saveCompletedDay(day)
    )
      return;
    this.milestone.delivered();
  }

  private completedDay(): string | null {
    try {
      const value: unknown = readJsonStateOrEnoent(this.progressFile);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).completedDay !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(
          (value as Record<string, unknown>).completedDay as string,
        )
      )
        throw new Error("Invalid surprise progress");
      return (value as { completedDay: string }).completedDay;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.paused = true;
      this.logger.error("Small surprise progress unreadable; schedule paused");
      return null;
    }
  }

  private saveCompletedDay(day: string): boolean {
    try {
      writeJsonState(this.progressFile, { completedDay: day });
      return true;
    } catch {
      this.paused = true;
      this.logger.error(
        "Small surprise progress could not be saved; schedule paused",
      );
      return false;
    }
  }
}
