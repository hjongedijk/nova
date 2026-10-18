import type { ConfirmableResult, MemoryRecord } from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

export const MEMORY_KINDS = [
  { id: "fact", label: "Feit" },
  { id: "preference", label: "Voorkeur" },
  { id: "decision", label: "Besluit" },
  { id: "assumption", label: "Aanname" },
  { id: "episode", label: "Episode" },
  { id: "project", label: "Project" },
] as const;
export type MemoryKindId = (typeof MEMORY_KINDS)[number]["id"];

/** A memory as GET /api/memories returns it, with the lifecycle fields. */
export interface MemoryItem extends MemoryRecord {
  kind?: string;
  sensitive?: boolean;
  superseded_by?: string | null;
  valid_until?: string | null;
}

export interface MemoryPage {
  memories: MemoryItem[];
  next?: string | number | null;
  unavailable?: string;
}

export interface MemoryQuery {
  kind?: MemoryKindId | "";
  q?: string;
  history?: boolean;
  /** The cursor of the previous page. */
  cursor?: string | number | null;
  limit?: number;
}

export function kindLabel(kind: string | undefined): string {
  return MEMORY_KINDS.find((item) => item.id === kind)?.label ?? "Feit";
}

/** Confidence (0 to 1) in words. A missing value counts as certain, like the API does for old records. */
export function confidenceWord(confidence: number | undefined): string {
  const value =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? confidence
      : 1;
  if (value >= 0.8) return "zeker";
  if (value >= 0.5) return "waarschijnlijk";
  return "niet bevestigd";
}

export const MASKED_TEXT = "Gevoelige herinnering, verborgen";

/** Sensitive text is never shown in full until the user asks for it. */
export function visibleText(item: MemoryItem, revealed: boolean): string {
  return item.sensitive === true && !revealed ? MASKED_TEXT : item.text;
}

export function memoryQueryPath(query: MemoryQuery): string {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 20));
  if (query.kind) params.set("kind", query.kind);
  const q = query.q?.trim();
  if (q) params.set("q", q);
  if (query.history) params.set("history", "true");
  if (
    query.cursor !== undefined &&
    query.cursor !== null &&
    query.cursor !== ""
  )
    params.set("offset", String(query.cursor));
  return `/memories?${params.toString()}`;
}

export const listMemories = (query: MemoryQuery = {}) =>
  getJson<MemoryPage>(memoryQueryPath(query));

export const correctMemory = (id: string, text: string, sessionId: string) =>
  sendJson<{ ok: boolean; error?: string }>(
    "POST",
    `/memories/${encodeURIComponent(id)}/correct`,
    { text, sessionId },
  );

/** Forgets one memory immediately. */
export const forgetMemoryRecord = (
  id: string,
  sessionId: string,
  withHistory: boolean,
) =>
  sendJson<ConfirmableResult>(
    "DELETE",
    `/memories/${encodeURIComponent(id)}${withHistory ? "?history=true" : ""}`,
    { sessionId },
  );
