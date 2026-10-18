import {
  readJsonStateOrEnoent,
  writeJsonState,
} from "../core/db/json-state.js";
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import { NovaConfig } from "../core/config/nova-config.js";
import { calendarEventStartInstant } from "../planning/calendar-day.js";
import { CalDavService } from "../planning/caldav.service.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { AlertsFeed } from "./alerts-feed.service.js";

const CHECK_MS = 60_000;
const MAX_REMEMBERED = 240;

interface ReminderProgress {
  reminded: string[];
}

/** Opt-in, once-per-event calendar reminders routed through NOVA's ordinary info alerts. */
@Injectable()
export class CalendarReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalendarReminderService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = false;

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly calendar: CalDavService,
    private readonly alerts: AlertsFeed,
  ) {
    this.progressFile = config.dataFile("calendar-reminders-progress.json");
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
    if (this.running || this.paused || !this.calendar.configured) return;
    const preferences = normalizeHelperPreferences(
      this.settings.get().helperPreferences as unknown as Record<
        string,
        unknown
      >,
    );
    const reminder = preferences.rituals?.calendarReminders;
    if (!reminder?.enabled) return;

    this.running = true;
    try {
      const progress = this.readProgress();
      const reminded = new Set(progress.reminded);
      const events = await this.calendar.upcomingForReminders(now);
      const leadMs = reminder.minutesBefore * 60_000;
      for (const { event, uid } of events) {
        // UID is required by iCalendar; without one, deduplication cannot safely
        // distinguish duplicate titles or persist a stable reminder identity.
        if (!uid) continue;
        const start = calendarEventStartInstant(event, this.config.timezone);
        if (!start) continue;
        const remaining = start.getTime() - now.getTime();
        if (remaining <= 0 || remaining > leadMs) continue;
        const key = crypto
          .createHash("sha256")
          .update(`${uid}\0${event.start}`)
          .digest("hex");
        if (reminded.has(key)) continue;
        const minutes = Math.max(1, Math.ceil(remaining / 60_000));
        const alert = this.alerts.record({
          topic: "jarvis/alerts",
          payload: {
            title: `Agenda: ${event.summary}`,
            detail: `Begint over ${minutes} ${minutes === 1 ? "minuut" : "minuten"}.`,
            severity: "info",
            key: `calendar-${key.slice(0, 32)}`,
            at: now.toISOString(),
          },
        });
        if (alert) {
          reminded.add(key);
          this.writeProgress([...reminded].slice(-MAX_REMEMBERED));
        }
      }
    } catch {
      this.logger.warn("Calendar reminders unavailable; retry scheduled");
    } finally {
      this.running = false;
    }
  }

  private readProgress(): ReminderProgress {
    try {
      const value = readJsonStateOrEnoent(
        this.progressFile,
      ) as Partial<ReminderProgress>;
      if (
        !Array.isArray(value.reminded) ||
        value.reminded.length > MAX_REMEMBERED ||
        value.reminded.some((key) => !/^[a-f0-9]{64}$/.test(key))
      )
        throw new Error("Invalid calendar reminder progress");
      return { reminded: value.reminded };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { reminded: [] };
      this.paused = true;
      this.logger.error(
        "Calendar reminder progress is unreadable; schedule paused",
      );
      return { reminded: [] };
    }
  }

  private writeProgress(reminded: string[]): void {
    try {
      writeJsonState(this.progressFile, { reminded });
    } catch {
      this.paused = true;
      this.logger.error(
        "Calendar reminder progress could not be saved; schedule paused",
      );
    }
  }
}
