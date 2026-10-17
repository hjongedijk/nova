export type ObjectiveKind = "monitor" | "followup";
export type Urgency = "info" | "warn" | "urgent";
export type Operator = ">" | "<" | ">=" | "<=" | "==" | "!=";

/**
 * A deterministic condition on the `result` of a READ_ONLY tool. `path` uses dots and `[]` to look at every element of an
 * array (`nodes[].cpu.usagePercent`). The condition describes the ANOMALY: it holds when something is wrong.
 */
export type Condition =
  | {
      kind: "compare";
      path: string;
      op: Operator;
      value: number | string | boolean;
    }
  | { kind: "empty"; path: string }
  | { kind: "not_empty"; path: string };

export interface CheckState {
  /** Consecutive checks in which the condition held. */
  consecutive: number;
  /** Consecutive failed tool calls. */
  errors: number;
  active: boolean;
  detail?: string;
}

export interface ObjectiveCheck {
  id: string;
  label: string;
  /** Always a READ_ONLY tool from the allowlist; validated at creation and again before every run. */
  tool: string;
  args: Record<string, unknown>;
  condition: Condition;
  /** Debounce: the condition must hold this many consecutive checks before it counts. */
  needed: number;
  urgency: Urgency;
  state: CheckState;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
}

export type ResultStatus = "ok" | "anomalie" | "fout" | "verlopen";

export interface HistoryEntry {
  at: number;
  status: ResultStatus;
  summary: string;
  /** What was done with an anomaly: gemeld, stil (quiet hours), cooldown, budget, gedempt (dismissed). */
  delivery?: string;
}

export interface ActiveAnomaly {
  signature: string;
  since: number;
  urgency: Urgency;
  detail: string;
  notified: boolean;
  dismissed: boolean;
}

export interface Objective {
  id: string;
  /** The user's own wording. */
  title: string;
  kind: ObjectiveKind;
  template: string;
  params: Record<string, unknown>;
  checks: ObjectiveCheck[];
  intervalMinutes: number;
  quiet: QuietHours;
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: number;
  expiresAt?: number;
  lastCheckAt?: number;
  lastResult?: { at: number; status: ResultStatus; summary: string };
  active?: ActiveAnomaly;
  lastNotifiedAt?: number;
  lastInvestigationAt?: number;
  lastInvestigation?: { runId: string; at: number; summary?: string };
  fulfilledAt?: number;
  /** The last 20 results. */
  history: HistoryEntry[];
  /** When anomalies started (last 30), for "afgelopen week twee storingen". */
  anomalyLog: number[];
  counters: {
    checks: number;
    anomalies: number;
    falseAlarms: number;
    notifications: number;
    suppressed: number;
    investigations: number;
  };
}

export interface ObjectivesFile {
  version: 1;
  objectives: Objective[];
  settings: { dailyBudget: number };
  usage: { day: string; notifications: number };
}

export class ObjectiveError extends Error {}

export const LIMITS = {
  titleMin: 3,
  titleMax: 120,
  maxActive: 5,
  maxTotal: 20,
  minInterval: 5,
  maxInterval: 1440,
  defaultCooldown: 30,
  maxCooldown: 1440,
  dailyBudget: 8,
  history: 20,
  anomalyLog: 30,
  investigationCooldownMinutes: 30,
  investigationTurns: 5,
  investigationMinutes: 8,
  errorsBeforeAnomaly: 3,
  maxExpiryDays: 365,
} as const;

export const DEFAULT_QUIET: QuietHours = {
  enabled: true,
  start: "23:00",
  end: "07:00",
  timezone: "Europe/Amsterdam",
};
