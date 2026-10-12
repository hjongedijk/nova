import type { FeedEvent } from "@nova/contracts";

export interface SavedHelperSnooze {
  event: FeedEvent;
  until: number;
}

const MAX_SNOOZES = 20;
const MAX_AGE_AFTER_DUE_MS = 60 * 60_000;

/** Browser storage is untrusted. Keep only bounded, recent feed data. */
export function readHelperSnoozes(
  raw: string,
  now = Date.now(),
): SavedHelperSnooze[] {
  if (raw.length > 20_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-MAX_SNOOZES).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const { event, until } = item as Record<string, unknown>;
    if (
      typeof until !== "number" ||
      !Number.isFinite(until) ||
      until < now - MAX_AGE_AFTER_DUE_MS ||
      until > now + 24 * 60 * 60_000 ||
      !event ||
      typeof event !== "object" ||
      Array.isArray(event)
    )
      return [];
    const value = event as Record<string, unknown>;
    if (
      (value.kind !== "alert" && value.kind !== "timer") ||
      !["info", "warning", "critical"].includes(String(value.severity)) ||
      typeof value.title !== "string" ||
      value.title.length > 120 ||
      typeof value.detail !== "string" ||
      value.detail.length > 240 ||
      typeof value.at !== "string" ||
      value.at.length > 40
    )
      return [];
    const restored: FeedEvent = {
      seq: -(index + 1),
      kind: value.kind as FeedEvent["kind"],
      severity: value.severity as FeedEvent["severity"],
      title: value.title,
      detail: value.detail,
      at: value.at,
      ...(typeof value.label === "string"
        ? { label: value.label.slice(0, 60) }
        : {}),
      ...(typeof value.key === "string" ? { key: value.key.slice(0, 80) } : {}),
      speakAllowed: false,
      deliveryMode: ["screen", "helper", "speak"].includes(
        String(value.deliveryMode),
      )
        ? (value.deliveryMode as FeedEvent["deliveryMode"])
        : "helper",
    };
    return [{ event: restored, until }];
  });
}

export function writeHelperSnoozes(items: SavedHelperSnooze[]): string {
  return JSON.stringify(items.slice(-MAX_SNOOZES));
}
