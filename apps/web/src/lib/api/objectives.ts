import { getJson, sendJson } from "./client.ts";

export interface ObjectiveView {
  id: string;
  title: string;
  kind: "monitor" | "followup";
  template: string;
  enabled: boolean;
  intervalMinutes: number;
  /** "23:00-07:00" or "uit". */
  quietHours: string;
  expiresAt?: string;
  fulfilledAt?: string;
  lastResult?: { at: string; status: string; summary: string };
  activeAnomaly?: {
    since: string;
    urgency: string;
    detail: string;
    dismissed: boolean;
  };
  counters: {
    checks: number;
    anomalies: number;
    falseAlarms: number;
    notifications: number;
    suppressed: number;
    investigations: number;
  };
  anomaliesLast7Days: number;
  lastInvestigation?: { at: string; summary?: string };
}

export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 1440;

const TEMPLATES: Record<string, string> = {
  servers_gezond: "Servers gezond",
  service_online: "Dienst bereikbaar",
  ha_waarde: "Waarde in Home Assistant",
  agenda_leeg: "Lege agenda",
};

export function templateLabel(view: Pick<ObjectiveView, "template" | "kind">) {
  const name = TEMPLATES[view.template] ?? view.template;
  return view.kind === "followup" ? `${name} (eenmalig)` : name;
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `elke ${minutes} minuten`;
  if (minutes === 60) return "elk uur";
  if (minutes % 60 === 0) return `elke ${minutes / 60} uur`;
  return `elke ${minutes} minuten`;
}

export interface ObjectiveStatus {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
}

export function objectiveStatus(view: ObjectiveView): ObjectiveStatus {
  if (view.fulfilledAt) return { tone: "neutral", label: "afgerond" };
  if (!view.enabled) return { tone: "neutral", label: "gepauzeerd" };
  if (view.activeAnomaly && !view.activeAnomaly.dismissed)
    return { tone: "warn", label: "afwijking" };
  if (view.lastResult?.status === "fout")
    return { tone: "bad", label: "controle mislukt" };
  return { tone: "ok", label: "ok" };
}

/** Quiet hours the PUT accepts: "uit" or "HH:MM-HH:MM". */
export function validQuietHours(value: string): boolean {
  const text = value.trim();
  if (text === "uit" || text === "aan") return true;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return false;
  const [, h1, m1, h2, m2] = m.map(Number);
  return h1! <= 23 && h2! <= 23 && m1! <= 59 && m2! <= 59;
}

export function validInterval(value: number): boolean {
  return (
    Number.isInteger(value) && value >= MIN_INTERVAL && value <= MAX_INTERVAL
  );
}

export const getObjectives = () =>
  getJson<{ objectives: ObjectiveView[] }>("/objectives");

export interface ObjectivePatch {
  enabled?: boolean;
  dismiss?: boolean;
  intervalMinutes?: number;
  quietHours?: string;
}
export const updateObjective = (id: string, patch: ObjectivePatch) =>
  sendJson<ObjectiveView>(
    "PUT",
    `/objectives/${encodeURIComponent(id)}`,
    patch,
  );

/** The API removes it at once; the confirmation step lives in the page. */
export const deleteObjective = (id: string) =>
  sendJson<{ deleted: boolean }>(
    "DELETE",
    `/objectives/${encodeURIComponent(id)}`,
  );
