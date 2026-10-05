import type { ButtonPress, PublicConfig, WidgetData } from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

/** GET /api/settings/public: no PIN needed. Sidebar layout, custom panels, quick actions. */
export const getPublicConfig = () => getJson<PublicConfig>("/settings/public");

/** Live data of the custom panels, by panel id. */
export const getWidgetData = () =>
  getJson<Record<string, WidgetData>>("/widgets/data");

/** Press button `index` of a buttons panel; the server says what to do next. */
export const pressWidgetButton = (id: string, index: number) =>
  sendJson<ButtonPress>(
    "POST",
    `/widgets/${encodeURIComponent(id)}/press`,
    { index },
    { "x-nova-admin": "1" },
  );
