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
