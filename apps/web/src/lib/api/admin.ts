import type {
  AuditLogEntry,
  ConfirmableResult,
  GatewayReport,
  IntegrationsReport,
  MemoryListResponse,
  ProvidersReport,
} from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

export const getIntegrations = () =>
  getJson<IntegrationsReport>("/integrations");
export const getProviders = () => getJson<ProvidersReport>("/providers");
export const getGateway = () => getJson<GatewayReport>("/gateway");
export const getAudit = (limit = 100) =>
  getJson<{ entries: AuditLogEntry[] }>(`/audit?limit=${limit}`);
export const getMemories = (limit = 50) =>
  getJson<MemoryListResponse>(`/memories?limit=${limit}`);

/**
 * Remember something. The API answers 400 with `{ok:false,error}` for a refused text and 200 with
 * `requiresConfirmation` when a card must be confirmed first; both are results, not exceptions.
 */
export async function rememberMemory(
  text: string,
  sessionId: string,
): Promise<ConfirmableResult> {
  const response = await fetch("/api/memories", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId }),
  });
  return (await response
    .json()
    .catch(() => ({ ok: false }))) as ConfirmableResult;
}

export const forgetMemory = (id: string, sessionId: string) =>
  sendJson<ConfirmableResult>("DELETE", `/memories/${encodeURIComponent(id)}`, {
    sessionId,
  });

/** POST /api/actions/confirm: answer a confirmation card. */
export const confirmAction = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  sendJson<{ reply: string }>("POST", "/actions/confirm", {
    sessionId,
    confirmationId,
    approve,
  });
