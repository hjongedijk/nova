import type { AlertsResponse, NovaStatus, PublicConfig } from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

/** GET /api/health (the rich form): the header's status dot and the routing notice. */
export const getStatus = () => getJson<NovaStatus>("/health");

/** GET /api/settings/public: quick actions, public address, sidebar. */
export const getPublicConfig = () => getJson<PublicConfig>("/settings/public");

/** GET /api/alerts?since=N: what NOVA says unasked (timers, watchdog). */
export const getAlerts = (since: number) =>
  getJson<AlertsResponse>(`/alerts?since=${since}`);

export const claimAlertSpeech = async (seq: number): Promise<boolean> =>
  (await sendJson<{ claimed: boolean }>("POST", `/alerts/${seq}/claim-speech`))
    .claimed;
