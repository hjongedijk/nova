import { getJson, sendJson } from "#lib/api/client.ts";
import type { VizProviderInfo, VizScene, VizSceneResponse } from "./types.ts";

export const listProviders = (): Promise<{ providers: VizProviderInfo[] }> =>
  getJson("/visualizations/providers");

export const openProvider = (source: string): Promise<{ scene: VizScene }> =>
  sendJson("POST", "/visualizations", { source });

export const readScene = (
  id: string,
  since?: number,
): Promise<VizSceneResponse> =>
  getJson(
    `/visualizations/${encodeURIComponent(id)}${since ? `?since=${since}` : ""}`,
  );

export const closeScene = (id: string): Promise<{ cleared: true }> =>
  sendJson("DELETE", `/visualizations/${encodeURIComponent(id)}`);

export const exportUrl = (id: string, format: "json" | "csv"): string =>
  `/api/visualizations/${encodeURIComponent(id)}/export?format=${format}`;
