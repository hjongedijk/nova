export type Urgency = "info" | "warn" | "urgent";
export type ScanName = "calendar" | "home" | "health" | "nudges" | "today";
export const SCAN_NAMES: readonly ScanName[] = [
  "calendar",
  "home",
  "health",
  "nudges",
  "today",
];

/** What a scan found. The text is built from templates in code: no model, no private content beyond a title. */
export interface Finding {
  id: string;
  scan: ScanName;
  urgency: Urgency;
  /** Same situation, same key: it is announced once, then waits for its cooldown. */
  key: string;
  cooldownMinutes: number;
  title: string;
  /** Plain Dutch: what is going on and one concrete next step. */
  detail: string;
}

export interface AutopilotSettings {
  /** Master switch and kill switch. */
  enabled: boolean;
  intervalMinutes: number;
  quiet: { enabled: boolean; start: string; end: string; timezone: string };
  dailyBudget: number;
  hourlyLimit: number;
  /** Text saved contacts that may talk with NOVA (Linphone). */
  textContacts: boolean;
  /** Only findings at or above this urgency are texted (the web feed gets all of them). */
  textMinUrgency: Urgency;
  /** Urgent findings may start a phone call, only if the autonomy level lets NOVA call by herself. Off by default. */
  allowCalls: boolean;
  scans: Record<ScanName, boolean>;
  calendarLeadMinutes: number;
  staleMinutes: number;
  /** Self-heal safe things only (clear a stuck model cooldown, refresh health). */
  selfHeal: boolean;
}

export type ActivityKind =
  | "scan"
  | "finding"
  | "sent"
  | "text"
  | "call"
  | "suppressed"
  | "heal"
  | "bootstrap"
  | "delegated"
  | "setting";

/** Metadata only: never message text, titles of events or names of people. */
export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  scan?: ScanName;
  urgency?: Urgency;
  findingId?: string;
  outcome?: string;
}

export interface FindingSummary {
  id: string;
  scan: ScanName;
  urgency: Urgency;
  title: string;
  at: number;
  outcome: string;
}

export interface AutopilotFile {
  version: 1;
  settings: AutopilotSettings;
  /** When the next scan is due (epoch ms); persisted so a restart resumes instead of bursting. */
  nextDueAt: number;
  lastScanAt?: number;
  bootstrapped: boolean;
  usage: { day: string; count: number };
  /** Delivery times in the last hour, for the global rate limit. */
  recentSends: number[];
  /** key -> last time it was announced. */
  sent: Record<string, number>;
  /** Home Assistant entity -> consecutive scans in which it was unavailable (and whether it was announced). */
  homeMisses: Record<string, number>;
  /** Pending findings from the last scan, for the status view. */
  lastFindings: FindingSummary[];
  activity: ActivityEntry[];
}

export const DEFAULT_SETTINGS: AutopilotSettings = {
  enabled: true,
  intervalMinutes: 5,
  quiet: {
    enabled: true,
    start: "23:00",
    end: "07:00",
    timezone: "Europe/Amsterdam",
  },
  dailyBudget: 10,
  hourlyLimit: 3,
  textContacts: true,
  textMinUrgency: "info",
  allowCalls: false,
  scans: {
    calendar: true,
    home: true,
    health: true,
    nudges: true,
    today: true,
  },
  calendarLeadMinutes: 30,
  staleMinutes: 30,
  selfHeal: true,
};

export const LIMITS = {
  activity: 200,
  findings: 20,
  sentKeepMs: 7 * 86_400_000,
  minInterval: 1,
  maxInterval: 60,
} as const;

export class AutopilotError extends Error {}
