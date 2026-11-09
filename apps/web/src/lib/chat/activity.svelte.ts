import {
  emptyActivity,
  reduceActivity,
  type ActivityEvent,
  type ActivityState,
} from "./activity.ts";

/** The live activity windows on screen. Only `dispatchActivity` writes it. */
export const activity = $state<{ value: ActivityState; now: number }>({
  value: emptyActivity(),
  now: Date.now(),
});

let ticker: ReturnType<typeof setInterval> | null = null;

/** Running steps count their seconds and finished ones expire, so a light tick runs while windows exist. */
function syncTicker(): void {
  const needed = activity.value.items.length > 0;
  if (needed && !ticker)
    ticker = setInterval(() => dispatchActivity({ type: "tick" }), 250);
  if (!needed && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function dispatchActivity(event: ActivityEvent): void {
  const now = Date.now();
  activity.now = now;
  const next = reduceActivity(activity.value, event, now);
  if (next !== activity.value) activity.value = next;
  syncTicker();
}
