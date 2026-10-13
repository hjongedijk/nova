import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
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

/** Sparse, opt-in occasions with fixed copy; never inspects private chat. */
@Injectable()
export class SmallSurprisesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmallSurprisesService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private paused = false;

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly alerts: AlertsFeed,
    private readonly presence: SpeechPresenceService,
  ) {
    this.progressFile = config.dataFile("small-surprises-progress.json");
  }

  onModuleInit(): void {
    this.checkSchedule();
    this.timer = setInterval(() => this.checkSchedule(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  checkSchedule(now = new Date()): void {
    if (this.paused) return;
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
      const occasion =
        preferences.wardrobe?.birthday === `${parts.month}-${parts.day}`
          ? "birthday"
          : `${parts.month}-${parts.day}` === "01-01"
            ? "newYear"
            : null;
      if (!occasion || this.completedDay() === day || this.paused) return;
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

  private completedDay(): string | null {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.progressFile, "utf8"),
      );
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
      const temporary = `${this.progressFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ completedDay: day }), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.progressFile);
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
