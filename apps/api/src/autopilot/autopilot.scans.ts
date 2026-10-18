import crypto from "node:crypto";
import type { AgentRun } from "../agent/agent.types.js";
import type { Objective } from "../objectives/objectives.types.js";
import { calendarEventStartInstant } from "../planning/calendar-day.js";
import { localDay, localMinutes } from "../objectives/objectives.time.js";
import { proposalText, type Candidate } from "../apis/lan-discovery.js";
import { T } from "./autopilot.templates.js";
import type {
  AutopilotSettings,
  Finding,
  ScanName,
  Urgency,
} from "./autopilot.types.js";

const MIN = 60_000;

/** Read-only access to tools: returns null when the tool does not exist or is switched off. */
export interface ReadTools {
  has(name: string): boolean;
  read(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown } | null>;
}

export interface ScanPorts {
  tools: ReadTools;
  routing?: { status(): { ready: boolean; status: string; reason?: string } };
  metrics?: {
    report(): Promise<{
      available: boolean;
      models: { requests: number; failures: number; enabled: boolean }[];
    }>;
  };
  mcp?: {
    status(): {
      servers: { id: string; enabled: boolean; connected: boolean }[];
    };
    refresh(server: string): Promise<void>;
  };
  telephony?: {
    enabled: boolean;
    textReady(): Promise<{ ready: boolean; reason?: string }>;
  };
  home?: {
    configured: boolean;
    health(): { stale: boolean; online: boolean };
    sync(force?: boolean): Promise<unknown>;
  };
  /** Read-only LAN discovery: scans at most daily and lists what is worth proposing. */
  discovery?: {
    refresh(): Promise<void>;
    proposals(): Candidate[];
  };
  agent?: { list(): AgentRun[] };
  objectives?: { list(): Objective[] };
  system?: {
    diskFreePercent(): Promise<number | null>;
    memoryFreePercent(): number | null;
  };
  /** Records a self-heal action (metadata only). */
  healed(note: string): void;
}

export interface ScanContext {
  now: number;
  settings: AutopilotSettings;
  timezone: string;
  /** Persistent per-entity miss counters (Home Assistant debounce). Mutated by the home scan. */
  misses: Record<string, number>;
  ports: ScanPorts;
  /** Heal attempts made recently, so a broken thing is retried at most every 30 minutes. */
  healAttempts: Map<string, number>;
}

const hash = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

export function finding(
  scan: ScanName,
  urgency: Urgency,
  key: string,
  cooldownMinutes: number,
  text: { title: string; detail: string },
): Finding {
  return {
    id: crypto.randomBytes(4).toString("hex"),
    scan,
    urgency,
    key,
    cooldownMinutes,
    title: text.title,
    detail: text.detail,
  };
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];

// ---- (a) calendar -----------------------------------------------------------------------------

export async function scanCalendar(ctx: ScanContext): Promise<Finding[]> {
  const out = await ctx.ports.tools.read("calendar_events");
  const result = out?.ok ? (out.result as Record<string, unknown>) : null;
  if (!result || result.configured === false) return [];
  const lead = ctx.settings.calendarLeadMinutes * MIN;
  const found: Finding[] = [];
  for (const event of records(result.events)) {
    const start = calendarEventStartInstant(
      {
        start: String(event.start ?? ""),
        timeZone: typeof event.timeZone === "string" ? event.timeZone : null,
        allDay: event.allDay === true,
      },
      ctx.timezone,
    );
    if (!start || typeof event.summary !== "string") continue;
    const remaining = start.getTime() - ctx.now;
    if (remaining <= 0 || remaining > lead) continue;
    const left = Math.max(1, Math.ceil(remaining / MIN));
    found.push(
      finding(
        "calendar",
        "info",
        // One reminder per event: the key follows the event and its start, never the minutes left.
        `calendar:${hash(`${event.summary}\0${event.start}`)}`,
        24 * 60,
        T.calendar(event.summary, left),
      ),
    );
  }
  return found;
}

// ---- (b) Home Assistant -----------------------------------------------------------------------

const WATCHED_DOMAINS = new Set([
  "light",
  "switch",
  "cover",
  "lock",
  "climate",
  "fan",
  "media_player",
  "alarm_control_panel",
  "vacuum",
]);
/** At or above this many at once it is a hub or integration, not individual devices. */
const MASS = 4;
const NEEDED_SCANS = 2;

export async function scanHome(ctx: ScanContext): Promise<Finding[]> {
  const out = await ctx.ports.tools.read("ha_search_entities", {});
  // Home Assistant itself unreachable is the health scan's business; never count it as "everything went away".
  if (!out?.ok) return [];
  const unavailable = new Map<string, string>();
  for (const entity of records(out.result)) {
    const id = entity.entity_id;
    if (typeof id !== "string" || !WATCHED_DOMAINS.has(id.split(".")[0] ?? ""))
      continue;
    if (entity.state === "unavailable")
      unavailable.set(
        id,
        typeof entity.friendly_name === "string" && entity.friendly_name
          ? entity.friendly_name
          : id,
      );
  }
  const prefix = "ha:";
  for (const key of Object.keys(ctx.misses))
    if (key.startsWith(prefix) && !unavailable.has(key.slice(prefix.length)))
      delete ctx.misses[key];
  const ripe: [string, string][] = [];
  for (const [id, name] of unavailable) {
    const count = (ctx.misses[`${prefix}${id}`] ?? 0) + 1;
    ctx.misses[`${prefix}${id}`] = count;
    // A device that blinks out for one scan is flapping, not broken.
    if (count >= NEEDED_SCANS) ripe.push([id, name]);
  }
  if (!ripe.length) return [];
  ripe.sort((a, b) => a[0].localeCompare(b[0]));
  if (ripe.length >= MASS)
    return [
      finding("home", "warn", "home:many", 12 * 60, T.homeMany(ripe.length)),
    ];
  return ripe.map(([id, name]) =>
    finding("home", "warn", `home:${id}`, 12 * 60, T.homeDevice(name)),
  );
}

// ---- (c) NOVA's own health --------------------------------------------------------------------

const HEAL_RETRY_MS = 30 * MIN;

export async function scanHealth(ctx: ScanContext): Promise<Finding[]> {
  const { ports } = ctx;
  const found: Finding[] = [];

  const route = ports.routing?.status();
  if (route && !route.ready)
    found.push(
      finding(
        "health",
        "warn",
        `health:routing:${route.status}`,
        6 * 60,
        T.routingBlocked(route.status),
      ),
    );

  if (route?.ready && ports.metrics) {
    try {
      const report = await ports.metrics.report();
      const used = report.models.filter((m) => m.enabled && m.requests >= 5);
      if (
        report.available &&
        used.length >= 2 &&
        used.every((m) => m.failures / m.requests >= 0.8)
      )
        found.push(
          finding(
            "health",
            "warn",
            "health:models-failing",
            6 * 60,
            T.modelsFailing(used.length),
          ),
        );
    } catch {
      /* metrics are optional */
    }
  }

  if (ports.telephony?.enabled) {
    const text = await ports.telephony.textReady();
    if (!text.ready && text.reason === "de trunk is niet geregistreerd")
      found.push(
        finding("health", "warn", "health:trunk", 6 * 60, T.trunkOffline()),
      );
  }

  if (ports.mcp) {
    for (const server of ports.mcp.status().servers) {
      if (!server.enabled || server.connected) continue;
      const tried = ctx.healAttempts.get(`mcp:${server.id}`);
      if (
        ctx.settings.selfHeal &&
        (tried === undefined || ctx.now - tried >= HEAL_RETRY_MS)
      ) {
        // Reconnecting a worker is safe: it changes no configuration.
        ctx.healAttempts.set(`mcp:${server.id}`, ctx.now);
        try {
          await ports.mcp.refresh(server.id);
        } catch {
          /* still down: reported below */
        }
        const now = ports.mcp.status().servers.find((s) => s.id === server.id);
        if (now?.connected) {
          ports.healed("mcp_reconnected");
          continue;
        }
      }
      found.push(
        finding(
          "health",
          "warn",
          `health:mcp:${server.id}`,
          12 * 60,
          T.mcpDown(server.id),
        ),
      );
    }
  }

  if (ports.home?.configured && ports.home.health().stale) {
    const count = (ctx.misses["health:ha"] ?? 0) + 1;
    ctx.misses["health:ha"] = count;
    const tried = ctx.healAttempts.get("ha");
    if (
      ctx.settings.selfHeal &&
      (tried === undefined || ctx.now - tried >= HEAL_RETRY_MS)
    ) {
      ctx.healAttempts.set("ha", ctx.now);
      try {
        await ports.home.sync(true);
      } catch {
        /* reported below when it persists */
      }
      if (!ports.home.health().stale) {
        ports.healed("home_assistant_refreshed");
        delete ctx.misses["health:ha"];
      }
    }
    if (ports.home.health().stale && count >= NEEDED_SCANS)
      found.push(
        finding("health", "warn", "health:ha", 12 * 60, T.haOffline()),
      );
  } else delete ctx.misses["health:ha"];

  const disk = await ports.system?.diskFreePercent();
  if (typeof disk === "number" && disk < 15)
    found.push(
      finding(
        "health",
        disk < 5 ? "urgent" : "warn",
        "health:disk",
        12 * 60,
        T.diskLow(Math.round(disk)),
      ),
    );
  const memory = ports.system?.memoryFreePercent();
  if (typeof memory === "number" && memory < 6)
    found.push(
      finding(
        "health",
        "warn",
        "health:memory",
        12 * 60,
        T.memoryLow(Math.round(memory)),
      ),
    );
  return found;
}

// ---- (d) nudges -------------------------------------------------------------------------------

export function scanNudges(ctx: ScanContext): Finding[] {
  const found: Finding[] = [];
  const stale = ctx.settings.staleMinutes * MIN;
  for (const run of ctx.ports.agent?.list() ?? []) {
    if (run.status !== "waiting" && run.status !== "interrupted") continue;
    const waited = ctx.now - run.updatedAt;
    if (waited < stale) continue;
    const text =
      run.status === "interrupted"
        ? T.runInterrupted(run.goal)
        : T.runWaiting(
            run.goal,
            Math.round(waited / MIN),
            run.waiting?.kind === "approval",
          );
    found.push(
      finding(
        "nudges",
        "warn",
        `nudge:run:${run.id}:${run.status}`,
        6 * 60,
        text,
      ),
    );
  }
  for (const o of ctx.ports.objectives?.list() ?? []) {
    const active = o.active;
    if (!o.enabled || !active || active.dismissed) continue;
    const age = ctx.now - active.since;
    if (age < stale) continue;
    found.push(
      finding(
        "nudges",
        "info",
        `nudge:objective:${o.id}:${active.since}`,
        12 * 60,
        T.objectiveOpen(o.title, Math.round(age / MIN)),
      ),
    );
  }
  return found;
}

// ---- (e) today --------------------------------------------------------------------------------

export async function scanToday(ctx: ScanContext): Promise<Finding[]> {
  // Once a day, from eight o'clock local time: a morning heads-up, not a ticker.
  if (localMinutes(ctx.now, ctx.settings.quiet.timezone) < 8 * 60) return [];
  let items = 0;
  let timers = 0;
  const list = await ctx.ports.tools.read("list_show", { list: "taken" });
  if (list?.ok)
    items = records((list.result as { items?: unknown })?.items).length;
  const timer = await ctx.ports.tools.read("timer_list");
  if (timer?.ok)
    timers = Number((timer.result as { count?: unknown })?.count) || 0;
  if (items + timers === 0) return [];
  const day = localDay(ctx.now, ctx.settings.quiet.timezone);
  return [
    finding("today", "info", `today:${day}`, 20 * 60, T.today(items, timers)),
  ];
}

/** One-line proposals for services found on the LAN ("Ik vond Home Assistant op ... - verbinden?"). */
async function scanDiscovery(ctx: ScanContext): Promise<Finding[]> {
  const discovery = ctx.ports.discovery;
  if (!discovery) return [];
  await discovery.refresh();
  return discovery
    .proposals()
    .slice(0, 3)
    .map((c) =>
      finding(
        "discovery",
        "info",
        `discovery:${c.id}`,
        7 * 24 * 60,
        proposalText(c),
      ),
    );
}

export async function runScan(
  name: ScanName,
  ctx: ScanContext,
): Promise<Finding[]> {
  switch (name) {
    case "calendar":
      return scanCalendar(ctx);
    case "home":
      return scanHome(ctx);
    case "health":
      return scanHealth(ctx);
    case "nudges":
      return scanNudges(ctx);
    case "today":
      return scanToday(ctx);
    case "discovery":
      return scanDiscovery(ctx);
  }
}
