import { getJson, sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";

export interface DesktopSettings {
  viewEnabled: boolean;
  controlEnabled: boolean;
  cacheEnabled: boolean;
}
export interface DesktopSessionInfo {
  id: string;
  goal: string;
  startedAt: number;
  expiresAt: number;
  actions: number;
  maxActions: number;
  observations: number;
  lastActivityAt: number;
}
export interface DesktopAuditRow {
  id: string;
  at: string;
  tool?: string;
  risk?: string;
  confirmation?: string;
  phase?: string;
  reason?: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
}
export interface DesktopOverview {
  configured: boolean;
  settings: DesktopSettings;
  session: DesktopSessionInfo | null;
  disarmPending: boolean;
  agent: {
    viewAvailable: boolean;
    controlAvailable: boolean;
    armed: boolean;
  } | null;
  agentError?: string;
  audit: DesktopAuditRow[];
}

const headers = (): Record<string, string> => {
  const pin = getPin();
  return { "x-nova-admin": "1", ...(pin ? { "x-nova-pin": pin } : {}) };
};

export const getDesktop = () =>
  getJson<DesktopOverview>("/settings/desktop", { headers: headers() });
export const saveDesktop = (patch: Partial<DesktopSettings>) =>
  sendJson<{ settings: DesktopSettings }>(
    "PUT",
    "/settings/desktop",
    patch,
    headers(),
  );
export const stopDesktop = () =>
  sendJson<{ ok: true; wasRunning: boolean; agentDisarmed: boolean }>(
    "POST",
    "/settings/desktop/stop",
    {},
    headers(),
  );
