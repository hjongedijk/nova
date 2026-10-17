import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { parseClock } from "../objectives/objectives.time.js";
import {
  AutopilotError,
  DEFAULT_SETTINGS,
  LIMITS,
  SCAN_NAMES,
  type ActivityEntry,
  type AutopilotFile,
  type AutopilotSettings,
} from "./autopilot.types.js";

export const emptyFile = (): AutopilotFile => ({
  version: 1,
  settings: structuredClone(DEFAULT_SETTINGS),
  nextDueAt: 0,
  bootstrapped: false,
  usage: { day: "", count: 0 },
  recentSends: [],
  sent: {},
  homeMisses: {},
  lastFindings: [],
  activity: [],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function int(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new AutopilotError(`${name} moet tussen ${min} en ${max} liggen.`);
  return Math.round(n);
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new AutopilotError(`${name} moet aan of uit zijn.`);
  return value;
}

function timezone(value: unknown): string {
  if (typeof value !== "string")
    throw new AutopilotError("Ongeldige tijdzone.");
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
  } catch {
    throw new AutopilotError("Ongeldige tijdzone.");
  }
  return value;
}

function clock(value: unknown, name: string): string {
  if (typeof value !== "string" || parseClock(value) === null)
    throw new AutopilotError(`${name} moet een tijd zijn zoals 23:00.`);
  return value.trim();
}

/** Validates a partial settings object on top of the current settings. Throws AutopilotError for anything unusable. */
export function applySettings(
  current: AutopilotSettings,
  patch: unknown,
): AutopilotSettings {
  if (!isObject(patch)) throw new AutopilotError("Ongeldige instellingen.");
  const next = structuredClone(current);
  if (patch.enabled !== undefined)
    next.enabled = bool(patch.enabled, "enabled");
  if (patch.textContacts !== undefined)
    next.textContacts = bool(patch.textContacts, "textContacts");
  if (patch.allowCalls !== undefined)
    next.allowCalls = bool(patch.allowCalls, "allowCalls");
  if (patch.selfHeal !== undefined)
    next.selfHeal = bool(patch.selfHeal, "selfHeal");
  if (patch.textMinUrgency !== undefined) {
    if (
      patch.textMinUrgency !== "info" &&
      patch.textMinUrgency !== "warn" &&
      patch.textMinUrgency !== "urgent"
    )
      throw new AutopilotError("textMinUrgency: info, warn of urgent.");
    next.textMinUrgency = patch.textMinUrgency;
  }
  if (patch.intervalMinutes !== undefined)
    next.intervalMinutes = int(
      patch.intervalMinutes,
      "intervalMinutes",
      LIMITS.minInterval,
      LIMITS.maxInterval,
    );
  if (patch.dailyBudget !== undefined)
    next.dailyBudget = int(patch.dailyBudget, "dailyBudget", 0, 100);
  if (patch.hourlyLimit !== undefined)
    next.hourlyLimit = int(patch.hourlyLimit, "hourlyLimit", 0, 30);
  if (patch.calendarLeadMinutes !== undefined)
    next.calendarLeadMinutes = int(
      patch.calendarLeadMinutes,
      "calendarLeadMinutes",
      5,
      240,
    );
  if (patch.staleMinutes !== undefined)
    next.staleMinutes = int(patch.staleMinutes, "staleMinutes", 5, 1440);
  if (patch.quiet !== undefined) {
    if (!isObject(patch.quiet))
      throw new AutopilotError("Ongeldige stille uren.");
    const q = patch.quiet;
    if (q.enabled !== undefined)
      next.quiet.enabled = bool(q.enabled, "quiet.enabled");
    if (q.start !== undefined) next.quiet.start = clock(q.start, "quiet.start");
    if (q.end !== undefined) next.quiet.end = clock(q.end, "quiet.end");
    if (q.timezone !== undefined) next.quiet.timezone = timezone(q.timezone);
  }
  if (patch.scans !== undefined) {
    if (!isObject(patch.scans)) throw new AutopilotError("Ongeldige scans.");
    for (const [name, value] of Object.entries(patch.scans)) {
      if (!(SCAN_NAMES as readonly string[]).includes(name))
        throw new AutopilotError(`Onbekende scan: ${name}.`);
      next.scans[name as keyof typeof next.scans] = bool(
        value,
        `scans.${name}`,
      );
    }
  }
  return next;
}

/** Reads stored settings leniently: a bad value falls back to its default instead of breaking the autopilot. */
function lenientSettings(raw: unknown): AutopilotSettings {
  let settings = structuredClone(DEFAULT_SETTINGS);
  if (!isObject(raw)) return settings;
  const attempt = (patch: Record<string, unknown>) => {
    try {
      settings = applySettings(settings, patch);
    } catch {
      /* keep the default for this one value */
    }
  };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "quiet" && isObject(value))
      for (const [k, v] of Object.entries(value))
        attempt({ quiet: { [k]: v } });
    else if (key === "scans" && isObject(value))
      for (const [k, v] of Object.entries(value))
        attempt({ scans: { [k]: v } });
    else attempt({ [key]: value });
  }
  return settings;
}

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** autopilot.json (mode 0600), written atomically with fsync. */
@Injectable()
export class AutopilotStore {
  private readonly log = new Logger("NOVA autopilot");
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("autopilot.json");
  }

  load(): AutopilotFile {
    let parsed: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!isObject(raw)) return emptyFile();
      parsed = raw;
    } catch {
      return emptyFile();
    }
    const base = emptyFile();
    const usage = isObject(parsed.usage) ? parsed.usage : {};
    return {
      version: 1,
      settings: lenientSettings(parsed.settings),
      nextDueAt: num(parsed.nextDueAt),
      lastScanAt:
        typeof parsed.lastScanAt === "number" ? parsed.lastScanAt : undefined,
      bootstrapped: parsed.bootstrapped === true,
      usage: {
        day: typeof usage.day === "string" ? usage.day : "",
        count: num(usage.count),
      },
      recentSends: Array.isArray(parsed.recentSends)
        ? parsed.recentSends.filter((n): n is number => typeof n === "number")
        : [],
      sent: isObject(parsed.sent)
        ? Object.fromEntries(
            Object.entries(parsed.sent).filter(
              (e): e is [string, number] => typeof e[1] === "number",
            ),
          )
        : base.sent,
      homeMisses: isObject(parsed.homeMisses)
        ? Object.fromEntries(
            Object.entries(parsed.homeMisses).filter(
              (e): e is [string, number] => typeof e[1] === "number",
            ),
          )
        : base.homeMisses,
      lastFindings: Array.isArray(parsed.lastFindings)
        ? (parsed.lastFindings as AutopilotFile["lastFindings"]).slice(
            -LIMITS.findings,
          )
        : [],
      activity: Array.isArray(parsed.activity)
        ? (parsed.activity as ActivityEntry[]).slice(-LIMITS.activity)
        : [],
    };
  }

  save(data: AutopilotFile): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data, null, 1), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } catch {
      this.log.warn("Could not save autopilot.json");
      throw new Error("Could not save autopilot.json");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
