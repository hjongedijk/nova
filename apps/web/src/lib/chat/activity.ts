/*
 * The live activity windows' state machine. Each tool step of a turn becomes one window:
 *   running ──tool_result ok──▶ done ──turn end + linger──▶ (removed)
 *          └─tool_result fail─▶ failed ─────────────────────▶ (removed)
 * A pinned window never expires; hovering or reading one holds its timer. Pure: time comes in as `now`.
 */
import type { ToolPreview } from "@nova/contracts";

export type ActivityPhase = "running" | "done" | "failed";
export type ActivityKind = ToolPreview["kind"] | "generic";

export interface Activity {
  id: string;
  turn: number;
  step: number;
  tool: string;
  label: string;
  kind: ActivityKind;
  phase: ActivityPhase;
  startedAt: number;
  endedAt: number | null;
  preview: ToolPreview | null;
  pinned: boolean;
  /** Held while the pointer rests on it or its details are open. */
  held: boolean;
  /** Removal time once the turn is over; null while the turn runs or when pinned. */
  expiresAt: number | null;
}

export interface ActivityState {
  turn: number;
  live: boolean;
  items: Activity[];
}

/** How long finished windows stay after the answer, and how many the store keeps at most. */
export const LINGER_MS = 6000;
export const KEEP_MAX = 24;
/** Tools that are bookkeeping, not something worth a window. */
const HIDDEN = new Set(["nova_tools_search"]);

export type ActivityEvent =
  | { type: "turn_start" }
  | { type: "tool_start"; data: Record<string, unknown> | null }
  | { type: "tool_result"; data: Record<string, unknown> | null }
  | { type: "turn_end"; failed?: boolean }
  | { type: "tick" }
  | { type: "pin"; id: string; pinned?: boolean }
  | { type: "hold"; id: string; held: boolean }
  | { type: "dismiss"; id: string };

export const emptyActivity = (): ActivityState => ({
  turn: 0,
  live: false,
  items: [],
});

const LABELS: [RegExp, string][] = [
  [/^web_search$/, "Zoeken op het web"],
  [/^web_read$/, "Pagina lezen"],
  [/^wikipedia$/, "Wikipedia raadplegen"],
  [/^news_headlines$/, "Nieuws ophalen"],
  [/^browser_search$/, "Zoeken in de browser"],
  [/^browser_(read|open|status|tab|back)$/, "Browser lezen"],
  [/^browser_/, "Browser bedienen"],
  [/^desktop_screenshot$/, "Scherm bekijken"],
  [/^desktop_/, "Pc bedienen"],
  [/^windows_/, "Windows bedienen"],
  [/^termix_run_command$/, "Opdracht op server"],
  [/^termix_/, "Servers controleren"],
  [/^code_(search|file_tree|file_read)/, "Code doorzoeken"],
  [/^code_git/, "Git bekijken"],
  [/^code_/, "Code bewerken"],
  [/^(ha_|home_)/, "Huis bedienen"],
  [/^proxmox_/, "Proxmox controleren"],
  [/^weather_/, "Weer ophalen"],
  [/^air_/, "Luchtkwaliteit meten"],
  [/^calendar_/, "Agenda bekijken"],
  [/^(timer|list)_/, "Planning bijwerken"],
  [/^(notes|documents)_/, "Notities doorzoeken"],
  [/^memory_/, "Geheugen raadplegen"],
  [/^(market_|currency_)/, "Koersen ophalen"],
  [/^calculate$/, "Rekenen"],
  [/^route_/, "Route berekenen"],
  [/^phone_/, "Telefoon"],
  [/^(system_time|clock_time)$/, "Tijd controleren"],
  [/^api_/, "Koppeling gebruiken"],
];

/** A short Dutch label for a tool name; unknown tools read as their own words. */
export function activityLabel(tool: string): string {
  const known = LABELS.find(([pattern]) => pattern.test(tool))?.[1];
  if (known) return known;
  const words = tool.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Actie";
}

/** The window's layout family: the preview's kind when it has one, else what the tool name implies. */
export function activityKind(
  tool: string,
  preview: ToolPreview | null,
): ActivityKind {
  if (preview && preview.kind !== "status") return preview.kind;
  if (/^(web_search|news_headlines|browser_search)$/.test(tool))
    return "search";
  if (/^(web_read|wikipedia|browser_(read|open|status|tab|back))$/.test(tool))
    return "page";
  if (tool === "desktop_screenshot") return "screen";
  if (/^(termix_run_command|code_)/.test(tool)) return "terminal";
  if (/^(ha_|home_|proxmox_|weather_|calendar_)/.test(tool)) return "data";
  return "generic";
}

const KINDS = new Set([
  "search",
  "page",
  "screen",
  "terminal",
  "data",
  "status",
]);
const str = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/** Accept only the preview shape we know; anything else from the wire becomes null. */
export function readPreview(value: unknown): ToolPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  const list = <T>(
    input: unknown,
    map: (item: Record<string, unknown>) => T | null,
  ) =>
    Array.isArray(input)
      ? input
          .slice(0, 50)
          .flatMap((item) =>
            item && typeof item === "object"
              ? [map(item as Record<string, unknown>)].filter(
                  (entry): entry is T => entry !== null,
                )
              : [],
          )
      : undefined;
  const preview: Record<string, unknown> = { kind: raw.kind };
  for (const key of [
    "query",
    "title",
    "domain",
    "snippet",
    "question",
    "text",
    "host",
    "command",
    "output",
    "message",
  ]) {
    const text = str(raw[key], 2000);
    if (text) preview[key] = text;
  }
  if (Number.isSafeInteger(raw.total)) preview.total = raw.total;
  if (Number.isSafeInteger(raw.exitCode)) preview.exitCode = raw.exitCode;
  const results = list(raw.results, (item) =>
    typeof item.title === "string"
      ? { title: item.title.slice(0, 200), domain: str(item.domain, 100) ?? "" }
      : null,
  );
  if (results) preview.results = results;
  const rows = list(raw.rows, (item) =>
    typeof item.label === "string" && typeof item.value === "string"
      ? { label: item.label.slice(0, 80), value: item.value.slice(0, 120) }
      : null,
  );
  if (rows) preview.rows = rows;
  return preview as unknown as ToolPreview;
}

/** A start preview (the query) and a result preview (the hits) of the same kind combine. */
function merge(
  before: ToolPreview | null,
  after: ToolPreview | null,
): ToolPreview | null {
  if (!after) return before;
  if (!before || before.kind !== after.kind) return after;
  return { ...before, ...after } as ToolPreview;
}

const stepOf = (data: Record<string, unknown> | null): number | null =>
  typeof data?.step === "number" && Number.isSafeInteger(data.step)
    ? data.step
    : null;

function expire(item: Activity, now: number): Activity {
  return item.pinned || item.held
    ? { ...item, expiresAt: null }
    : { ...item, expiresAt: now + LINGER_MS };
}

/** One transition of the activity state. */
export function reduceActivity(
  state: ActivityState,
  event: ActivityEvent,
  now: number,
): ActivityState {
  switch (event.type) {
    case "turn_start": {
      // A new question clears the previous turn's windows, except the pinned ones.
      return {
        turn: state.turn + 1,
        live: true,
        items: state.items.filter((item) => item.pinned),
      };
    }
    case "tool_start": {
      const tool = String(event.data?.name ?? "").slice(0, 80);
      if (!tool || HIDDEN.has(tool)) return state;
      const turnItems = state.items.filter((item) => item.turn === state.turn);
      const step =
        stepOf(event.data) ??
        Math.max(0, ...turnItems.map((item) => item.step)) + 1;
      const id = `${state.turn}:${step}:${tool}`;
      if (state.items.some((item) => item.id === id)) return state;
      const preview = readPreview(event.data?.preview);
      const item: Activity = {
        id,
        turn: state.turn,
        step,
        tool,
        label: activityLabel(tool),
        kind: activityKind(tool, preview),
        phase: "running",
        startedAt: now,
        endedAt: null,
        preview,
        pinned: false,
        held: false,
        expiresAt: null,
      };
      return {
        ...state,
        items: [...state.items, item].slice(-KEEP_MAX),
      };
    }
    case "tool_result": {
      const tool = String(event.data?.name ?? "");
      const step = stepOf(event.data);
      let index = -1;
      for (let i = state.items.length - 1; i >= 0 && index < 0; i--) {
        const item = state.items[i]!;
        if (
          item.turn === state.turn &&
          item.phase === "running" &&
          item.tool === tool &&
          (step === null || item.step === step)
        )
          index = i;
      }
      if (index < 0) return state;
      const current = state.items[index]!;
      const ok = event.data?.ok === true && event.data?.verified !== false;
      const preview = merge(current.preview, readPreview(event.data?.preview));
      const next: Activity = {
        ...current,
        phase: ok ? "done" : "failed",
        endedAt: now,
        preview,
        kind: activityKind(current.tool, preview),
      };
      const items = state.items.slice();
      items[index] = state.live ? next : expire(next, now);
      return { ...state, items };
    }
    case "turn_end": {
      return {
        ...state,
        live: false,
        items: state.items.map((item) =>
          item.turn !== state.turn
            ? item
            : expire(
                item.phase === "running"
                  ? {
                      ...item,
                      phase: event.failed ? "failed" : "done",
                      endedAt: now,
                    }
                  : item,
                now,
              ),
        ),
      };
    }
    case "tick": {
      const items = state.items.filter(
        (item) => item.expiresAt === null || item.expiresAt > now,
      );
      return items.length === state.items.length ? state : { ...state, items };
    }
    case "pin":
    case "hold": {
      return {
        ...state,
        items: state.items.map((item) => {
          if (item.id !== event.id) return item;
          const next =
            event.type === "pin"
              ? { ...item, pinned: event.pinned ?? !item.pinned }
              : { ...item, held: event.held };
          if (next.pinned || next.held) return { ...next, expiresAt: null };
          // Released or unpinned after the answer: a fresh linger, never an instant vanish.
          const lingering =
            next.phase !== "running" &&
            !(state.live && next.turn === state.turn);
          return lingering ? expire(next, now) : next;
        }),
      };
    }
    case "dismiss":
      return {
        ...state,
        items: state.items.filter((item) => item.id !== event.id),
      };
  }
}

/** "0,4 s", "12 s", "1 min 5 s": how long a step took (or has been running). */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(".", ",")} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

export const PHASE_LABEL: Record<ActivityPhase, string> = {
  running: "bezig",
  done: "klaar",
  failed: "mislukt",
};

/** The letter shown in a site's monogram tile (no favicons are fetched). */
export function monogram(domain: string | undefined): string {
  const host = (domain ?? "").replace(/^(www|m|nl|en)\./, "");
  const letter = [...host].find((char) => /\p{L}|\p{N}/u.test(char));
  return letter ? letter.toLocaleUpperCase("nl") : "·";
}
