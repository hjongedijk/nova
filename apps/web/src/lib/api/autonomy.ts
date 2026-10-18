import { getJson, sendJson } from "./client.ts";

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
