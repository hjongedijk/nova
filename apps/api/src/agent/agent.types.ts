export type RunStatus =
  "running" | "waiting" | "done" | "failed" | "cancelled" | "interrupted";

export interface RunLogEntry {
  at: number;
  kind: "start" | "turn" | "wait" | "resume" | "done" | "stopped" | "note";
  text: string;
}

export interface AgentRun {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  turns: number;
  maxTurns: number;
  /** Only READ_ONLY tools may run (enforced by the tool layer, not by the prompt). */
  readOnly?: boolean;
  /** Epoch ms after which the run stops by itself. */
  deadline: number;
  log: RunLogEntry[];
  /** What NOVA tells the user when the run ended. */
  result?: string;
  /** Set while the run waits for the user: an approval, or an answer to a question. */
  waiting?: {
    kind: "approval" | "question";
    text: string;
    confirmationId?: string;
    tool?: string;
  };
}

export interface AgentFile {
  version: 1;
  runs: AgentRun[];
  /** Model turns used today (UTC day), to protect the free quotas. */
  usage: { day: string; turns: number };
}

export class AgentError extends Error {}

export const LIMITS = {
  goalMin: 6,
  goalMax: 600,
  defaultTurns: 8,
  maxTurns: 14,
  defaultMinutes: 10,
  maxMinutes: 30,
  concurrent: 2,
  dailyTurns: 60,
  keepRuns: 40,
  logEntries: 40,
} as const;
