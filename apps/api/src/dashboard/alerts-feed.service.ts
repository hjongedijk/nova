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
import { WorkflowFeedJournal } from "./workflow-feed-journal.js";
import { TimerFeedJournal } from "./timer-feed-journal.js";
import { SettingsStore } from "../settings/store/settings.store.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const MAX_EVENTS = 50;
const MAX_SPOKEN_EVENTS_PER_HOUR = 5;
const SPOKEN_EVENT_WINDOW_MS = 60 * 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_REPEAT_KEYS = 100;
const DEFERRED_MAX_AGE_MS = 4 * 60 * 60_000;
const MAX_FOCUS_MINUTES = 240;

export interface FocusStatus {
  active: boolean;
  until: string | null;
  pending: number;
  workBlock: boolean;
  needsReset?: boolean;
}

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
  private stopTimers?: () => void;
  private readonly timerJournal?: TimerFeedJournal;
  private timerHistoryRestored = false;
  private readonly workflowJournal?: WorkflowFeedJournal;
  private workflowHistoryRestored = false;
  private stopPresence?: () => void;
  private deferredTimer?: NodeJS.Timeout;
  private readonly deferredWhileAway = new Map<number, number>();
  private readonly spokenEventTimes: number[] = [];
  private readonly speechProgressFile?: string;
  private speechProgressUnavailable = false;
  private readonly focusFile?: string;
  private focus: { until: number; count: number; workBlock: boolean } | null =
    null;
  private focusUnreadable = false;
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
      this.focusFile = config.dataFile("focus-mode.json");
      this.loadFocus();
      this.timerJournal = new TimerFeedJournal(
        config.dataFile("timer-feed.json"),
      );
      this.workflowJournal = new WorkflowFeedJournal(
        config.dataFile("workflow-feed.json"),
      );
      try {
        this.restoreWorkflowHistory();
      } catch {
        this.logger.warn(
          "Workflow feed history unavailable; workflows remain queued",
        );
      }
      try {
        this.restoreTimerHistory();
      } catch {
        this.logger.warn(
          "Timer feed history unavailable; pending timers remain queued",
        );
      }
    }
  }

  private restoreTimerHistory(): void {
    if (!this.timerJournal || this.timerHistoryRestored) return;
    for (const { event } of this.timerJournal.read().slice(-MAX_EVENTS)) {
      // Recovery restores visible history without replaying speech/cues/native delivery.
      this.restoreEvent(event);
      this.sequence = Math.max(this.sequence, event.seq);
    }
    this.timerHistoryRestored = true;
  }

  private restoreEvent(event: FeedEvent): void {
    this.feed.push({ ...event, speakAllowed: false, deliveryMode: "screen" });
    this.feed.sort((a, b) => a.seq - b.seq);
    if (this.feed.length > MAX_EVENTS)
      this.feed.splice(0, this.feed.length - MAX_EVENTS);
    this.sequence = Math.max(this.sequence, event.seq);
  }

  private restoreWorkflowHistory(): void {
    if (!this.workflowJournal || this.workflowHistoryRestored) return;
    for (const { event } of this.workflowJournal.read().slice(-MAX_EVENTS))
      this.restoreEvent(event);
    this.workflowHistoryRestored = true;
  }

  onModuleInit(): void {
    this.stop = this.planning.onEvent((event) => {
      if (event.topic !== "jarvis/events/timer" || !this.planning.onTimerEvent)
        this.record(event);
    });
    this.stopTimers = this.planning.onTimerEvent?.((event) => {
      if (!this.timerJournal) return false;
      return this.record(event) !== null;
    });
    this.stopPresence = this.presence?.onSpeechAvailable(() =>
      this.releaseDeferred(),
    );
    this.deferredTimer = setInterval(() => {
      this.settleFocus();
      this.releaseDeferred();
    }, 60_000);
    this.deferredTimer.unref();
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stopTimers?.();
    this.stopPresence?.();
    if (this.deferredTimer) clearInterval(this.deferredTimer);
  }

  record(
    event: InfrastructureEvent,
    now = new Date(),
    workflowId?: string,
  ): FeedEvent | null {
    if (workflowId) {
      if (
        !/^nova-workflow:[a-f0-9]{64}$/.test(workflowId) ||
        !this.workflowJournal
      )
        throw new Error("Workflow feed history unavailable");
      this.restoreWorkflowHistory();
      const accepted = this.workflowJournal.find(workflowId);
      if (accepted) {
        if (!this.feed.some((event) => event.seq === accepted.seq))
          this.restoreEvent(accepted);
        return accepted;
      }
    }
    const timerId =
      event.topic === "jarvis/events/timer" &&
      typeof event.payload?.deliveryId === "string"
        ? event.payload.deliveryId
        : null;
    if (timerId && this.timerJournal) {
      if (!/^[a-f0-9]{8}:\d+$/.test(timerId)) return null;
      this.restoreTimerHistory();
      const accepted = this.timerJournal.find(timerId);
      if (accepted) return accepted;
    }
    this.settleFocus(now);
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
    const focused = this.focusUnreadable || this.focus !== null;
    if (focused && this.focus && !workflowId) {
      this.focus.count = Math.min(100_000, this.focus.count + 1);
      try {
        this.saveFocus(this.focus);
      } catch {
        // The alert must stay visible and silent even when focus storage fails.
      }
    }
    if (
      !workflowId &&
      entry.kind === "alert" &&
      entry.severity !== "critical"
    ) {
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
    const voiceEligible = mode === "speak" && !focused;
    const presenceAllowsSpeech = this.presence?.maySpeak() !== false;
    const stored: FeedEvent = {
      seq: ++this.sequence,
      ...entry,
      speakAllowed: false,
      deliveryMode: focused ? "screen" : mode,
    };
    if (timerId && this.timerJournal) this.timerJournal.accept(timerId, stored);
    if (workflowId) {
      this.workflowJournal!.accept(workflowId, stored);
      if (focused && this.focus) {
        this.focus.count = Math.min(100_000, this.focus.count + 1);
        try {
          this.saveFocus(this.focus);
        } catch {
          /* accepted alert stays visible and silent */
        }
      }
    }
    // A failed durable acceptance must not spend speech budget on an unheard notice.
    stored.speakAllowed =
      voiceEligible && presenceAllowsSpeech && this.reserveSpeech(timestamp);
    this.feed.push(stored);
    if (voiceEligible && !presenceAllowsSpeech) {
      this.deferredWhileAway.set(stored.seq, timestamp);
      if (this.deferredWhileAway.size > MAX_EVENTS)
        this.deferredWhileAway.delete(
          this.deferredWhileAway.keys().next().value!,
        );
    }
    if (this.feed.length > MAX_EVENTS) this.feed.shift();
    if (
      !workflowId &&
      entry.kind === "alert" &&
      entry.severity !== "critical"
    ) {
      if (this.repeats.size >= MAX_REPEAT_KEYS)
        this.repeats.delete(this.repeats.keys().next().value!);
      this.repeats.set(
        JSON.stringify([entry.severity, entry.key, entry.title, entry.detail]),
        { firstAt: timestamp, count: 1, last: stored },
      );
    }
    if (!focused && mode !== "screen" && this.windows?.configured)
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
    deliveryId?: string;
  }): FeedEvent | null {
    return this.record(
      {
        topic: "jarvis/alerts",
        payload: {
          title: input.title,
          detail: input.detail ?? "",
          severity: input.severity ?? "info",
          key: input.category === "briefing" ? "briefing" : "node-red",
          at: input.at,
        },
      },
      new Date(),
      input.deliveryId,
    );
  }

  recent(since = 0): AlertsResponse {
    this.settleFocus();
    return {
      latest: this.sequence,
      events: this.feed.filter((item) => item.seq > since),
    };
  }

  /** First visible client to claim a spoken event wins across browser contexts. */
  claimSpeech(seq: number): boolean {
    this.settleFocus();
    if (this.focusUnreadable || this.focus) return false;
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    const event = this.feed.find((item) => item.seq === seq);
    if (!event?.speakAllowed || this.speechClaims.has(event)) return false;
    this.speechClaims.add(event);
    return true;
  }

  /** One bounded spoken summary when confirmed presence returns; original alerts stay visible. */
  private releaseDeferred(now = new Date()): void {
    if (this.focusUnreadable || this.focus) return;
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

  focusStatus(now = new Date()): FocusStatus {
    this.settleFocus(now);
    return {
      active: this.focusUnreadable || this.focus !== null,
      until: this.focus ? new Date(this.focus.until).toISOString() : null,
      pending: this.focus?.count ?? 0,
      workBlock: this.focus?.workBlock ?? false,
      ...(this.focusUnreadable ? { needsReset: true } : {}),
    };
  }

  startFocus(
    minutes: number,
    now = new Date(),
    workBlock = false,
  ): FocusStatus {
    if (
      !Number.isInteger(minutes) ||
      minutes < 5 ||
      minutes > MAX_FOCUS_MINUTES
    )
      throw new Error("Focusduur moet tussen 5 en 240 minuten liggen.");
    this.settleFocus(now);
    const next = {
      until: now.getTime() + minutes * 60_000,
      count: this.focus?.count ?? 0,
      workBlock,
    };
    this.saveFocus(next);
    this.focus = next;
    this.focusUnreadable = false;
    for (const item of this.feed) item.speakAllowed = false;
    this.deferredWhileAway.clear();
    return this.focusStatus(now);
  }

  startWorkBlock(now = new Date()): FocusStatus {
    return this.startFocus(25, now, true);
  }

  endFocus(now = new Date(), completed = false): FocusStatus {
    if (this.focus) {
      const count = this.focus.count;
      const workBlockCompleted = this.focus.workBlock && completed;
      this.saveFocus(null);
      this.focus = null;
      this.focusUnreadable = false;
      this.focusSummary(count, now, workBlockCompleted);
    } else if (this.focusUnreadable) {
      this.saveFocus(null);
      this.focusUnreadable = false;
    }
    return this.focusStatus(now);
  }

  private settleFocus(now = new Date()): void {
    if (this.focus && now.getTime() >= this.focus.until) {
      try {
        this.endFocus(now, true);
      } catch {
        // Storage failure keeps focus active and speech disabled.
      }
    }
  }

  private focusSummary(
    count: number,
    now: Date,
    workBlockCompleted = false,
  ): void {
    if (!count && !workBlockCompleted) return;
    const mode =
      this.settings?.get().helperPreferences.notifications?.info ?? "helper";
    const wantsSpeech = mode === "speak";
    const maySpeak = this.presence?.maySpeak() !== false;
    const speakAllowed =
      wantsSpeech && maySpeak && this.reserveSpeech(now.getTime());
    const summary: FeedEvent = {
      seq: ++this.sequence,
      kind: "alert",
      severity: "info",
      key: workBlockCompleted ? "work-break" : "focus-summary",
      title: workBlockCompleted
        ? "Werkblok klaar — tijd om even te bewegen"
        : `${count} ${count === 1 ? "melding" : "meldingen"} tijdens focus`,
      detail: count
        ? workBlockCompleted
          ? `${count} ${count === 1 ? "melding" : "meldingen"} tijdens focus. Bekijk ze in Meldingen.`
          : "Bekijk ze in Meldingen."
        : "Neem rustig een korte pauze.",
      at: now.toISOString(),
      deliveryMode:
        mode === "screen" ? "screen" : speakAllowed ? "speak" : "helper",
      speakAllowed,
    };
    this.feed.push(summary);
    if (this.feed.length > MAX_EVENTS) this.feed.shift();
    if (mode !== "screen" && this.windows?.configured)
      void this.windows.notifyHelper(summary).catch(() => undefined);
  }

  private loadFocus(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.focusFile!, "utf8")) as {
        until?: unknown;
        count?: unknown;
        workBlock?: unknown;
      };
      if (
        !Number.isSafeInteger(data?.until) ||
        (data.until as number) < 0 ||
        !Number.isSafeInteger(data?.count) ||
        (data.count as number) < 0 ||
        (data.count as number) > 100_000 ||
        (data.workBlock !== undefined && typeof data.workBlock !== "boolean")
      )
        throw new Error("Invalid focus status");
      if (data.until)
        this.focus = {
          until: data.until as number,
          count: data.count as number,
          workBlock: data.workBlock === true,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.focusUnreadable = true;
      this.logger.error("Focus status is unreadable; automatic speech paused");
    }
  }

  private saveFocus(
    value: { until: number; count: number; workBlock: boolean } | null,
  ): void {
    if (!this.focusFile) return;
    const temporary = `${this.focusFile}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(value ?? { until: 0, count: 0 }),
        { mode: 0o600 },
      );
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.focusFile);
    } catch {
      this.focusUnreadable = true;
      this.logger.error(
        "Focus status could not be saved; automatic speech paused",
      );
      throw new Error("Focusstatus kon niet worden opgeslagen.");
    }
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
