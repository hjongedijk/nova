import type {
  ActionResult,
  ActivityResponse,
  AlertsResponse,
  DashboardHealth,
  OverviewResponse,
  SystemResponse,
} from "@nova/contracts";
import { ApiError, getJson, sendJson } from "./client.ts";

export const getSystem = () => getJson<SystemResponse>("/system");
export const getOverview = () => getJson<OverviewResponse>("/overview");
export const getAlerts = (since: number) =>
  getJson<AlertsResponse>(`/alerts?since=${since}`);
export const getActivity = (limit = 30) =>
  getJson<ActivityResponse>(`/audit?limit=${limit}`);
export const getDashboardHealth = () => getJson<DashboardHealth>("/health");

/** Dashboard buttons run the same tools NOVA uses. Throws with the server's message when it fails. */
export async function executeAction(
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const data = await sendJson<ActionResult>("POST", "/actions/execute", {
    sessionId: "dashboard",
    tool,
    args,
  });
  if (data.ok === false)
    throw new ApiError(data.error || "Dat is niet gelukt.", 200);
}
