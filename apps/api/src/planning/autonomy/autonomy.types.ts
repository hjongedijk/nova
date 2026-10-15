/**
 * Durable autonomous tasks: a user-authorised list of tool steps that NOVA runs by itself
 * (once, repeatedly or when an event arrives). No model is called by the runner, so a run never
 * costs anything beyond the tools the user chose; risky steps wait for an explicit approval.
 */
export type TaskStatus =
  "scheduled" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "retry"
  | "done"
  | "failed"
  | "skipped";

export type TaskTrigger =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMs: number }
  | { kind: "event"; name: string; cooldownMs: number };

export interface AutoStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Earlier step ids that must be done first. Default: the previous step. */
  dependsOn: string[];
  maxAttempts: number;
  /** Follow-up/watch: repeat the (read-only) step until its result contains this text. */
  until?: { contains: string; pollEveryMs: number };
}

export interface StepState {
  status: StepStatus;
  attempts: number;
  nextAt?: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  approval?: { requestedAt: number; grantedAt?: number };
}

export interface RunState {
  id: string;
  startedAt: number;
  toolCalls: number;
  steps: Record<string, StepState>;
}

export interface AutoTask {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  trigger: TaskTrigger;
  steps: AutoStep[];
  /** SAFE steps may run unattended (still bound by the global auto-execute setting). */
  autoSafe: boolean;
  notifyOnDone: boolean;
  budget: {
    maxToolCalls: number;
    maxRunMs: number;
    maxRuns: number;
    expiresAt: number;
  };
  fingerprint: string;
  runs: number;
  consecutiveFailures: number;
  nextRunAt: number | null;
  lastTriggerAt?: number;
  pendingTrigger?: boolean;
  seenEvents: string[];
  run: RunState | null;
  lastRun?: { at: number; outcome: "ok" | "failed"; summary: string };
  note?: string;
}

export interface AutonomyFile {
  version: 1;
  tasks: AutoTask[];
}

export const LIMITS = {
  maxTasks: 30,
  maxActive: 15,
  maxSteps: 8,
  maxArgsChars: 2000,
  minEveryMs: 60_000,
  minPollMs: 30_000,
  minCooldownMs: 30_000,
  maxToolCallsCap: 200,
  defaultToolCalls: 30,
  defaultRunMs: 3_600_000,
  maxRunMsCap: 86_400_000,
  maxRunsCap: 1000,
  maxExpiryMs: 365 * 86_400_000,
  defaultExpiryMs: 30 * 86_400_000,
  approvalTtlMs: 24 * 3_600_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 900_000,
  maxConcurrentRuns: 3,
  maxConcurrentSteps: 2,
  maxConsecutiveFailures: 3,
} as const;

export class AutonomyError extends Error {}
