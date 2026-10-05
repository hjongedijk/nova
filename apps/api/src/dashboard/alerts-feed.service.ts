import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  AlertsResponse,
  FeedEvent,
  InfrastructureEvent,
} from "@nova/contracts";
import { sanitize } from "../core/security/sanitize.js";
import { PlanningService } from "../planning/planning.service.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const MAX_EVENTS = 50;

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
  private readonly feed: FeedEvent[] = [];
  private sequence = 0;
  private stop?: () => void;

  constructor(private readonly planning: PlanningService) {}

  onModuleInit(): void {
    this.stop = this.planning.onEvent((event) => this.record(event));
  }

  onModuleDestroy(): void {
    this.stop?.();
  }

  record(event: InfrastructureEvent): FeedEvent | null {
    const entry = toFeedEvent(event);
    if (!entry) return null;
    const stored: FeedEvent = { seq: ++this.sequence, ...entry };
    this.feed.push(stored);
    if (this.feed.length > MAX_EVENTS) this.feed.shift();
    return stored;
  }

  recent(since = 0): AlertsResponse {
    return {
      latest: this.sequence,
      events: this.feed.filter((item) => item.seq > since),
    };
  }
}
