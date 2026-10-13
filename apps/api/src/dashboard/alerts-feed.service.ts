import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import type {
  AlertsResponse,
  FeedEvent,
  InfrastructureEvent,
} from "@nova/contracts";
import { sanitize } from "../core/security/sanitize.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { WindowsPcService } from "../integrations/windows/windows-pc.service.js";
import { PlanningService } from "../planning/planning.service.js";
import { SpeechPresenceService } from "./speech-presence.service.js";
import { NtfyPushService } from "./ntfy-push.service.js";
import { SettingsStore } from "../settings/store/settings.store.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const MAX_EVENTS = 50;
const MAX_SPOKEN_EVENTS_PER_HOUR = 5;
const SPOKEN_EVENT_WINDOW_MS = 60 * 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_REPEAT_KEYS = 100;
const DEFERRED_MAX_AGE_MS = 4 * 60 * 60_000;

const text = (value: unknown, max: number) =>
  typeof value === "string" ? sanitize(value).slice(0, max) : "";

/**
 * Turns a raw event into what the interface shows. Every field is bounded, cleaned and meant to be
 * shown as plain text: events can also come from outside, over the message bus.
 */
export function toFeedEvent(
  event: InfrastructureEvent,
  now = new Date(),
): Omit<FeedEvent, "seq"> | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  if (event.topic === "jarvis/events/timer") {
    if (payload.type !== "timer_fired") return null;
    const label = text(payload.label, 60) || "timer";
    return {
      kind: "timer",
      severity: "info",
      title: `Timer afgelopen: ${label}`,
      label,
      detail: payload.late
        ? "Deze timer liep af terwijl ik even offline was."
        : "",
      at: text(payload.firedAt, 40) || now.toISOString(),
    };
  }
  if (event.topic === "jarvis/alerts") {
    const title = text(payload.title, 120);
    if (!title) return null;
    return {
      kind: "alert",
      severity: SEVERITIES.has(payload.severity as string)
        ? (payload.severity as FeedEvent["severity"])
        : "info",
      title,
      detail: text(payload.detail, 240),
      key: text(payload.key, 80),
      at: text(payload.at, 40) || now.toISOString(),
    };
  }
  return null;
}

/** Things NOVA should tell the user without being asked: watchdog alerts and fired timers. The interface polls this feed. */
@Injectable()
export class AlertsFeed implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsFeed.name);
  private readonly feed: FeedEvent[] = [];
  private readonly speechClaims = new WeakSet<FeedEvent>();
  private sequence = 0;
  private stop?: () => void;
  private stopPresence?: () => void;
  private deferredTimer?: NodeJS.Timeout;
  private readonly deferredWhileAway = new Map<number, number>();
  private readonly spokenEventTimes: number[] = [];
  private readonly speechProgressFile?: string;
  private speechProgressUnavailable = false;
  private readonly repeats = new Map<
    string,
    { firstAt: number; count: number; last: FeedEvent }
  >();

  constructor(
    private readonly planning: PlanningService,
    @Optional() private readonly windows?: WindowsPcService,
    @Optional() private readonly presence?: SpeechPresenceService,
    @Optional() private readonly ntfy?: NtfyPushService,
    @Optional() private readonly settings?: SettingsStore,
    @Optional() config?: NovaConfig,
  ) {
    if (config) {
      this.speechProgressFile = config.dataFile("spoken-alert-progress.json");
      this.loadSpeechProgress();
    }
  }

  onModuleInit(): void {
    this.stop = this.planning.onEvent((event) => this.record(event));
    this.stopPresence = this.presence?.onSpeechAvailable(() =>
      this.releaseDeferred(),
    );
    this.deferredTimer = setInterval(() => this.releaseDeferred(), 60_000);
    this.deferredTimer.unref();
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stopPresence?.();
    if (this.deferredTimer) clearInterval(this.deferredTimer);
  }

  record(event: InfrastructureEvent, now = new Date()): FeedEvent | null {
    const entry = toFeedEvent(event, now);
    if (!entry) return null;
    const timestamp = now.getTime();
    const notifications = this.settings?.get().helperPreferences.notifications;
    const category =
      entry.kind === "timer"
        ? "timer"
        : entry.key === "briefing"
          ? "briefing"
          : entry.severity;
    const mode =
      notifications?.[category] ?? (category === "info" ? "helper" : "speak");
    if (entry.kind === "alert" && entry.severity !== "critical") {
      for (const [key, value] of this.repeats)
        if (
          timestamp - value.firstAt >= REPEAT_WINDOW_MS ||
          timestamp < value.firstAt
        )
          this.repeats.delete(key);
      const key = JSON.stringify([
        entry.severity,
        entry.key,
        entry.title,
        entry.detail,
      ]);
      const repeated = this.repeats.get(key);
      if (repeated) {
        repeated.count++;
        if (repeated.count !== 3) return repeated.last;
        const summary: FeedEvent = {
          ...entry,
          seq: ++this.sequence,
          title: `${entry.title} (3 keer in 10 minuten)`,
          detail:
            "Herhaalde melding gebundeld; volgende herhalingen blijven stil.",
          at: now.toISOString(),
          speakAllowed: false,
          deliveryMode: "screen",
        };
        repeated.last = summary;
        this.feed.push(summary);
        if (this.feed.length > MAX_EVENTS) this.feed.shift();
        return summary;
      }
    }
    const voiceEligible = mode === "speak";
    const presenceAllowsSpeech = this.presence?.maySpeak() !== false;
    const withinSpeechBudget =
      !voiceEligible || !presenceAllowsSpeech || this.reserveSpeech(timestamp);
    const stored: FeedEvent = {
      seq: ++this.sequence,
      ...entry,
      speakAllowed:
        mode === "speak" && presenceAllowsSpeech && withinSpeechBudget,
      deliveryMode: mode,
    };
    this.feed.push(stored);
    if (voiceEligible && !presenceAllowsSpeech) {
      this.deferredWhileAway.set(stored.seq, timestamp);
      if (this.deferredWhileAway.size > MAX_EVENTS)
        this.deferredWhileAway.delete(
          this.deferredWhileAway.keys().next().value!,
        );
    }
    if (this.feed.length > MAX_EVENTS) this.feed.shift();
    if (entry.kind === "alert" && entry.severity !== "critical") {
      if (this.repeats.size >= MAX_REPEAT_KEYS)
        this.repeats.delete(this.repeats.keys().next().value!);
      this.repeats.set(
        JSON.stringify([entry.severity, entry.key, entry.title, entry.detail]),
        { firstAt: timestamp, count: 1, last: stored },
      );
    }
    if (mode !== "screen" && this.windows?.configured)
      void this.windows.notifyHelper(stored).catch(() => undefined);
    if (stored.kind === "alert" && stored.severity === "critical")
      void this.ntfy?.notify(stored).catch(() => undefined);
    return stored;
  }

  /** Accepts only the already-validated Node-RED alert projection. */
  recordNodeRedAlert(input: {
    title: string;
    detail?: string;
    severity?: "info" | "warning" | "critical";
    category?: "briefing";
    at?: string;
  }): FeedEvent | null {
    return this.record({
      topic: "jarvis/alerts",
      payload: {
        title: input.title,
        detail: input.detail ?? "",
        severity: input.severity ?? "info",
        key: input.category === "briefing" ? "briefing" : "node-red",
        at: input.at,
      },
    });
  }

  recent(since = 0): AlertsResponse {
    return {
      latest: this.sequence,
      events: this.feed.filter((item) => item.seq > since),
    };
  }

  /** First visible client to claim a spoken event wins across browser contexts. */
  claimSpeech(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    const event = this.feed.find((item) => item.seq === seq);
    if (!event?.speakAllowed || this.speechClaims.has(event)) return false;
    this.speechClaims.add(event);
    return true;
  }

  /** One bounded spoken summary when confirmed presence returns; original alerts stay visible. */
  private releaseDeferred(now = new Date()): void {
    if (this.presence?.maySpeak() !== true || !this.deferredWhileAway.size)
      return;
    const timestamp = now.getTime();
    const current = this.settings?.get().helperPreferences.notifications;
    const eligible: FeedEvent[] = [];
    for (const [seq, recordedAt] of this.deferredWhileAway) {
      const event = this.feed.find((item) => item.seq === seq);
      if (!event || timestamp - recordedAt > DEFERRED_MAX_AGE_MS) {
        this.deferredWhileAway.delete(seq);
        continue;
      }
      const category =
        event.kind === "timer"
          ? "timer"
          : event.key === "briefing"
            ? "briefing"
            : event.severity;
      if (current && current[category] !== "speak") {
        this.deferredWhileAway.delete(seq);
        continue;
      }
      eligible.push(event);
    }
    if (!eligible.length) return;
    if (!this.reserveSpeech(timestamp)) return;
    const count = eligible.length;
    const summary: FeedEvent = {
      seq: ++this.sequence,
      kind: "alert",
      severity: "info",
      key: "missed",
      title: `${count} gemiste ${count === 1 ? "melding" : "meldingen"}`,
      detail: "Bekijk ze in Meldingen.",
      at: now.toISOString(),
      deliveryMode: "speak",
      speakAllowed: true,
    };
    this.feed.push(summary);
    if (this.feed.length > MAX_EVENTS) this.feed.shift();
    this.deferredWhileAway.clear();
    if (this.windows?.configured)
      void this.windows.notifyHelper(summary).catch(() => undefined);
  }

  private loadSpeechProgress(): void {
    try {
      const value = JSON.parse(
        fs.readFileSync(this.speechProgressFile!, "utf8"),
      ) as { spokenAt?: unknown };
      const times = value?.spokenAt;
      if (
        !Array.isArray(times) ||
        times.length > MAX_SPOKEN_EVENTS_PER_HOUR ||
        times.some(
          (time, index) =>
            !Number.isSafeInteger(time) ||
            time < 0 ||
            (index > 0 && time < times[index - 1]),
        )
      )
        throw new Error("Invalid speech progress");
      this.spokenEventTimes.push(...(times as number[]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.speechProgressUnavailable = true;
      this.logger.error(
        "Speech progress is unreadable; automatic speech paused",
      );
    }
  }

  private reserveSpeech(timestamp: number): boolean {
    if (this.speechProgressUnavailable) return false;
    const recent = this.spokenEventTimes.filter(
      (time) => timestamp - time < SPOKEN_EVENT_WINDOW_MS,
    );
    if (recent.length >= MAX_SPOKEN_EVENTS_PER_HOUR) return false;
    const next = [...recent, timestamp].sort((a, b) => a - b);
    if (this.speechProgressFile) {
      try {
        const temporary = `${this.speechProgressFile}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ spokenAt: next }), {
          mode: 0o600,
        });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, this.speechProgressFile);
      } catch {
        this.speechProgressUnavailable = true;
        this.logger.error(
          "Speech progress could not be saved; automatic speech paused",
        );
        return false;
      }
    }
    this.spokenEventTimes.splice(0, this.spokenEventTimes.length, ...next);
    return true;
  }
}
