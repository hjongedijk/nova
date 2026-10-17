import { getJson, sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";

export interface AutonomyTask {
  id: string;
  title: string;
  status: string;
  trigger: string;
  nextRunAt: string | null;
  runs: string;
  steps: { id: string; tool: string; status: string }[];
  waitingForApproval: string[];
  last: { at: string; outcome: string; summary: string } | null;
}

export const getAutonomyTasks = () =>
  getJson<{ tasks: AutonomyTask[] }>("/autonomy/tasks");
export const approveAutonomyTask = (id: string) =>
  sendJson<{ approvedSteps: string[] }>(
    "POST",
    `/autonomy/tasks/${encodeURIComponent(id)}/approve`,
  );
export const cancelAutonomyTask = (id: string) =>
  sendJson<{ cancelled: boolean }>(
    "DELETE",
    `/autonomy/tasks/${encodeURIComponent(id)}`,
  );

export type AutonomyLevel = "careful" | "balanced" | "independent";
// The settings API wants the admin header on writes (and the PIN when one is set).
const adminHeaders = (): Record<string, string> => {
  const pin = getPin();
  return { "x-nova-admin": "1", ...(pin ? { "x-nova-pin": pin } : {}) };
};
export const getAutonomyLevel = () =>
  getJson<{ level: AutonomyLevel }>("/settings/autonomy-level", {
    headers: adminHeaders(),
  });
export const setAutonomyLevel = (level: AutonomyLevel) =>
  sendJson<{ level: AutonomyLevel }>(
    "PUT",
    "/settings/autonomy-level",
    { level },
    adminHeaders(),
  );

export interface AgentRunView {
  id: string;
  goal: string;
  status: string;
  turns: string;
  result?: string;
  waitingFor?: { kind: "approval" | "question"; text: string };
  lastStep?: string;
}
export const getAgentRuns = () =>
  getJson<{ runs: AgentRunView[] }>("/agent/runs");
export const cancelAgentRun = (id: string) =>
  sendJson<AgentRunView>(
    "POST",
    `/agent/runs/${encodeURIComponent(id)}/cancel`,
  );
export const respondAgentRun = (
  id: string,
  body: { approve?: boolean; answer?: string },
) =>
  sendJson<AgentRunView>(
    "POST",
    `/agent/runs/${encodeURIComponent(id)}/respond`,
    body,
  );
