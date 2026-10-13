import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import { NovaConfig } from "../core/config/nova-config.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { SpeechPresenceService } from "./speech-presence.service.js";

const CHECK_MS = 30_000;
const QUIET_RITUAL_TEXT: Record<
  "morning" | "evening" | "checkIn",
  { title: string; detail: string }
> = {
  morning: {
    title: "Goedemorgen",
    detail: "Ik ben er als je rustig wilt beginnen.",
  },
  evening: { title: "Welterusten", detail: "Ik wens je een rustige nacht." },
  checkIn: {
    title: "Even inchecken",
    detail: "Het is al even stil. Ik ben er als je iets nodig hebt.",
  },
};

export function localParts(
  date: Date,
  timezone: string,
): Record<string, string> {
  return Object.fromEntries(
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
}

export function inQuietHours(now: string, start: string, end: string): boolean {
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours! * 60 + minutes!;
  };
  const current = toMinutes(now);
  const from = toMinutes(start);
  const until = toMinutes(end);
  if (from === until) return true;
  return from < until
    ? current >= from && current < until
    : current >= from || current < until;
}

interface RitualProgress {
  day: string;
  morning: boolean;
  evening: boolean;
  checkIn: boolean;
  welcomeHome: boolean;
}

/** Opt-in, local-time greetings routed through the ordinary quiet/presence/speech policy. */
@Injectable()
export class RitualsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RitualsService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private paused = false;
  private stopArrival?: () => void;

  constructor(
    private readonly config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly session: SessionMemoryService,
    private readonly presence: SpeechPresenceService,
    private readonly alerts: AlertsFeed,
    private readonly home: HomeAssistantService,
  ) {
    this.progressFile = config.dataFile("rituals-progress.json");
  }

  onModuleInit(): void {
    void this.checkSchedule();
    this.stopArrival = this.presence.onTransition((from, to) => {
      if (from === "away" && to === "home") this.onArrival();
    });
    this.timer = setInterval(() => void this.checkSchedule(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopArrival?.();
  }

  /** A confirmed transition for the same visible person; never infer arrival from an unknown state. */
  onArrival(now = new Date()): void {
    if (this.paused) return;
    try {
      const preferences = normalizeHelperPreferences(
        this.settings.get().helperPreferences as unknown as Record<
          string,
          unknown
        >,
      );
      if (!preferences.rituals?.welcomeHome.enabled) return;
      const parts = localParts(now, this.config.timezone);
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}`;
      const quiet = preferences.cues.quiet;
      if (
        (quiet.enabled && inQuietHours(time, quiet.start, quiet.end)) ||
        this.alerts.focusStatus(now).active
      )
        return;
      const progress = this.readProgress(day);
      if (progress.welcomeHome || this.paused) return;
      const climates = this.home.visibleEntities().filter((entity) => {
        const value = entity.attributes?.current_temperature;
        const unit = entity.attributes?.temperature_unit;
        return (
          entity.domain === "climate" &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          (((unit === "°C" || unit === "C") && value >= -20 && value <= 50) ||
            ((unit === "°F" || unit === "F") && value >= -4 && value <= 122))
        );
      });
      const climate = climates.length === 1 ? climates[0] : undefined;
      const value = climate?.attributes?.current_temperature as
        number | undefined;
      const unit = climate?.attributes?.temperature_unit as string | undefined;
      const detail =
        value === undefined
          ? "Vraag me wat er vandaag op de planning staat."
          : `Volgens je thermostaat is het nu ${Math.round(value * 10) / 10} ${unit === "C" || unit === "°C" ? "°C" : "°F"}.`;
      progress.welcomeHome = true;
      this.saveProgress(progress);
      if (this.paused) return;
      this.alerts.record(
        {
          topic: "jarvis/alerts",
          payload: {
            title: "Welkom thuis",
            detail,
            severity: "info",
            key: "welcome-home",
            at: now.toISOString(),
          },
        },
        now,
      );
    } catch {
      this.logger.warn("Welcome-home greeting unavailable");
    }
  }

  async checkSchedule(now = new Date()): Promise<void> {
    if (this.running || this.paused) return;
    this.running = true;
    try {
      const parts = localParts(now, this.config.timezone);
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}`;
      const progress = this.readProgress(day);
      if (this.paused) return;
      const preferences = normalizeHelperPreferences(
        this.settings.get().helperPreferences as unknown as Record<
          string,
          unknown
        >,
      );
      const rituals = preferences.rituals;
      if (!rituals) return;
      const quiet = preferences.cues.quiet;
      const isQuiet =
        quiet.enabled && inQuietHours(time, quiet.start, quiet.end);
      if (isQuiet || this.presence.maySpeak() === false) return;

      let changed = false;
      if (
        rituals.morning.enabled &&
        time === rituals.morning.time &&
        !progress.morning
      ) {
        this.deliver("morning", now);
        progress.morning = true;
        changed = true;
      }
      if (
        rituals.evening.enabled &&
        time === rituals.evening.time &&
        !progress.evening
      ) {
        this.deliver("evening", now);
        progress.evening = true;
        changed = true;
      }
      if (
        rituals.checkIn.enabled &&
        !progress.checkIn &&
        time >= "10:00" &&
        time < "20:00" &&
        this.isLongSilence(now, rituals.checkIn.afterHours)
      ) {
        this.deliver("checkIn", now);
        progress.checkIn = true;
        changed = true;
      }
      if (changed) this.saveProgress(progress);
    } catch {
      this.logger.warn("Ritual schedule unavailable");
    } finally {
      this.running = false;
    }
  }

  private isLongSilence(now: Date, hours: number): boolean {
    const last = this.session.lastUserMessageAt();
    if (!last) return false;
    const elapsed = now.getTime() - Date.parse(last);
    return elapsed >= hours * 60 * 60_000;
  }

  private deliver(kind: keyof typeof QUIET_RITUAL_TEXT, now: Date): void {
    const copy = QUIET_RITUAL_TEXT[kind];
    this.alerts.record(
      {
        topic: "jarvis/alerts",
        payload: {
          title: copy.title,
          detail: copy.detail,
          severity: "info",
          key: `ritual-${kind}`,
          at: now.toISOString(),
        },
      },
      now,
    );
  }

  private readProgress(day: string): RitualProgress {
    try {
      const value = JSON.parse(
        fs.readFileSync(this.progressFile, "utf8"),
      ) as Partial<RitualProgress>;
      if (value.day === day)
        return {
          day,
          morning: value.morning === true,
          evening: value.evening === true,
          checkIn: value.checkIn === true,
          welcomeHome: value.welcomeHome === true,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.paused = true;
    }
    return {
      day,
      morning: false,
      evening: false,
      checkIn: false,
      welcomeHome: false,
    };
  }

  private saveProgress(progress: RitualProgress): void {
    try {
      const temporary = `${this.progressFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(progress), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.progressFile);
    } catch {
      this.paused = true;
      this.logger.error("Ritual progress could not be saved; schedule paused");
    }
  }
}
