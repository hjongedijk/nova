import type {
  ActivityEntry,
  DashboardHealth,
  FeedEvent,
  OverviewResponse,
  ProxmoxGuestInfo,
  SystemResponse,
} from "@nova/contracts";
import {
  executeAction,
  getActivity,
  getAlerts,
  getDashboardHealth,
  getOverview,
  getSystem,
} from "#lib/api/dashboard.ts";
import { showToast } from "./toasts.svelte.ts";
import { pollWidgetData } from "./sidebar.svelte.ts";

/** Longest graph: 90 samples of 3 seconds. */
export const MAX_HISTORY = 90;

/** What the side panels show. Everything here is written by the pollers below, nowhere else. */
export const dashboard = $state({
  system: null as SystemResponse | null,
  overview: null as OverviewResponse | null,
  /** The last overview request failed: the VM and storage panels show nothing then. */
  overviewFailed: false,
  health: null as DashboardHealth | null,
  /** The last health request failed. */
  healthFailed: false,
  activity: [] as ActivityEntry[],
  /** The VM the pointer or focus is on: the entity lights it up. */
  hotVmid: null as number | null,
});

/**
 * Graph history, newest last. Plain arrays on purpose: the charts redraw every animation frame
 * and read these directly.
 */
export const history = {
  cpu: [] as number[],
  memory: [] as number[],
  rx: [] as number[],
  tx: [] as number[],
};
let historySeeded = false;

/** The VMs and containers for the entity and the VM panel (empty when Proxmox does not answer). */
export function guests(): ProxmoxGuestInfo[] {
  return dashboard.overviewFailed
    ? []
    : (dashboard.overview?.proxmox?.guests ?? []);
}

const pct = (used: number, total: number) =>
  total > 0 ? Math.min(100, (used / total) * 100) : 0;

function push(list: number[], ...values: number[]): void {
  list.push(...values);
  while (list.length > MAX_HISTORY) list.shift();
}

/* ---------- pollers ---------- */

async function pollSystem(): Promise<void> {
  if (document.hidden) return;
  try {
    const d = await getSystem();
    const mem = pct(d.memory.used, d.memory.total);
    if (!historySeeded && d.history?.cpu?.length) {
      historySeeded = true;
      push(history.cpu, ...d.history.cpu);
      push(history.memory, ...d.history.memory);
    } else {
      historySeeded = true;
      push(history.cpu, d.cpu);
      push(history.memory, mem);
    }
    if (d.network) {
      if (history.rx.length === 0 && d.history?.rx?.length) {
        push(history.rx, ...d.history.rx);
        push(history.tx, ...d.history.tx);
      } else {
        push(history.rx, d.network.rxPerSec);
        push(history.tx, d.network.txPerSec);
      }
    }
    dashboard.system = d;
  } catch {
    /* keep the last known values */
  }
}

export async function pollOverview(): Promise<void> {
  if (document.hidden) return;
  try {
    dashboard.overview = await getOverview();
    dashboard.overviewFailed = false;
  } catch {
    dashboard.overviewFailed = true;
  }
}

async function pollActivity(): Promise<void> {
  if (document.hidden) return;
  try {
    const { entries } = await getActivity(30);
    dashboard.activity = (entries ?? [])
      .filter(
        (entry) =>
          entry.tool && !["health", "overview"].includes(entry.sessionId ?? ""),
      )
      .slice(0, 4);
  } catch {
    /* leave the last list in place */
  }
}

async function pollHealth(): Promise<void> {
  if (document.hidden) return;
  try {
    dashboard.health = await getDashboardHealth();
    dashboard.healthFailed = false;
  } catch {
    dashboard.healthFailed = true;
  }
}

/* ---------- what NOVA says unasked: alerts and timers that went off ---------- */

type FeedListener = (events: FeedEvent[]) => void;
let feedListeners: FeedListener[] = [];

/**
 * New alert and timer events (never the ones from before the page opened), each already shown as a
 * toast. The shell subscribes to speak them. Returns the unsubscribe function.
 */
export function onFeedEvents(listener: FeedListener): () => void {
  feedListeners = [...feedListeners, listener];
  return () => {
    feedListeners = feedListeners.filter((fn) => fn !== listener);
  };
}

let alertCursor: number | null = null;

async function pollAlerts(): Promise<void> {
  if (document.hidden) return;
  try {
    const data = await getAlerts(alertCursor ?? 0);
    const first = alertCursor === null;
    alertCursor = data.latest;
    if (first) return; // what happened before this page opened is history
    if (!data.events.length) return;
    for (const event of data.events) {
      showToast(
        { severity: event.severity, title: event.title, detail: event.detail },
        // Information goes away by itself; warnings stay until they are closed.
        event.severity === "info" ? 12000 : 2_000_000_000,
      );
    }
    for (const listener of feedListeners) listener(data.events);
    if (data.events.some((event) => event.kind === "timer"))
      void pollOverview();
  } catch {
    /* try again on the next tick */
  }
}

/* ---------- health, as the header and the Systeem panel read it ---------- */

/** NOVA's overall state for the menu: "Online", "Setup nodig", "Gratis AI niet beschikbaar" or "Offline". */
export function systemStatus(): { text: string; ok: boolean } | null {
  if (dashboard.healthFailed) return { text: "Offline", ok: false };
  const data = dashboard.health;
  if (!data) return null;
  const routingDown = data.routing?.ready === false;
  const text = routingDown
    ? "Gratis AI niet beschikbaar"
    : data.omnirouteConfigured
      ? "Online"
      : "Setup nodig";
  return { text, ok: !routingDown && Boolean(data.omnirouteConfigured) };
}

/** The line under the header when there is no verified free AI route; empty otherwise. */
export function routingNotice(): string {
  return !dashboard.healthFailed && dashboard.health?.routing?.ready === false
    ? "Geen geverifieerde gratis AI-route. Controleer Gratis AI onder Status & geheugen."
    : "";
}

/* ---------- start and stop ---------- */

let users = 0;
let timers: ReturnType<typeof setInterval>[] = [];

/**
 * Start the polling (idempotent; reference counted). Returns the function that stops it.
 * The side columns call it; the shell may call it too to get health and alerts without them.
 */
export function startDashboard(): () => void {
  users += 1;
  if (users === 1) {
    void pollHealth();
    void pollSystem();
    void pollOverview();
    void pollActivity();
    void pollAlerts();
    timers = [
      setInterval(pollHealth, 10000),
      setInterval(pollSystem, 3000),
      setInterval(pollOverview, 10000),
      setInterval(pollActivity, 20000),
      setInterval(pollAlerts, 4000),
      setInterval(() => {
        if (!document.hidden) void pollWidgetData();
      }, 60000),
    ];
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users === 0) {
      timers.forEach(clearInterval);
      timers = [];
    }
  };
}

/**
 * Run a tool from a dashboard button (stop a timer, add to a list), say how it went, and refresh
 * the panels right away.
 */
export async function runAction(
  tool: string,
  args: Record<string, unknown>,
  done: string,
): Promise<void> {
  try {
    await executeAction(tool, args);
    showToast({ severity: "info", title: done });
  } catch (error) {
    showToast({
      severity: "warning",
      title: "Dat lukte niet",
      detail: error instanceof Error ? error.message : "Dat is niet gelukt.",
    });
  }
  void pollOverview();
}
