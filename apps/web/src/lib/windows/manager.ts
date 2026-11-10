/*
 * NOVA's window manager, as plain functions over plain data so every rule is testable:
 *
 *   open ──▶ normal ⇄ maximized
 *              │ ▲
 *     minimize ▼ │ restore / focus
 *            minimized (in the dock)       close ──▶ (gone)
 *
 * - Placement cascades: each new floating window lands one step down-right of the last, wrapping inside the stage.
 * - Tiled layout puts every visible window in a grid that reflows as windows come and go.
 * - Finished activity windows settle: after a linger they go to the dock unless the owner touched them.
 * - Live windows (browser, screen) are capped: past MAX_LIVE the oldest finished ones go to the dock.
 */
import type { NovaWindowKind } from "@nova/contracts";

export type WindowMode = "normal" | "minimized" | "maximized";
export type WindowPhase = "running" | "done" | "failed" | "idle";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NovaWin extends Rect {
  id: string;
  kind: NovaWindowKind;
  title: string;
  mode: WindowMode;
  phase: WindowPhase;
  z: number;
  openedAt: number;
  updatedAt: number;
  /** When the step finished; settling counts from here. */
  doneAt: number | null;
  /** Owner moved, resized, focused or typed into it: it stays until closed. */
  touched: boolean;
  /** End result of a turn: shown large and never settles away. */
  result: boolean;
  /** Kind-specific display data (url, video, text, ...). */
  data: Record<string, unknown>;
}

export interface Stage {
  w: number;
  h: number;
  /** Space kept free for the header and the composer. */
  top: number;
  bottom: number;
}

export interface WindowState {
  windows: NovaWin[];
  focused: string | null;
  layout: "float" | "tile";
  mission: boolean;
  nextZ: number;
  /** Where the next cascaded window goes (step index). */
  cascade: number;
}

export const MAX_LIVE = 8;
export const MAX_WINDOWS = 16;
export const SETTLE_MS = 20_000;
export const MIN_SIZE = { w: 280, h: 180 };
const CASCADE_STEP = 32;
const GAP = 12;
const LIVE_KINDS = new Set<NovaWindowKind>(["browser", "screen"]);

export const isLive = (win: Pick<NovaWin, "kind">) => LIVE_KINDS.has(win.kind);

export function emptyState(): WindowState {
  return {
    windows: [],
    focused: null,
    layout: "float",
    mission: false,
    nextZ: 1,
    cascade: 0,
  };
}

/** A comfortable first size per kind, inside the stage. */
export function defaultSize(
  kind: NovaWindowKind,
  stage: Stage,
  result = false,
): { w: number; h: number } {
  const room = { w: stage.w - 32, h: stage.h - stage.top - stage.bottom };
  const want =
    result || kind === "page"
      ? { w: 960, h: 640 }
      : kind === "browser"
        ? { w: 720, h: 500 }
        : kind === "screen"
          ? { w: 640, h: 400 }
          : kind === "video"
            ? { w: 640, h: 380 }
            : kind === "terminal"
              ? { w: 620, h: 360 }
              : kind === "reader" || kind === "document"
                ? { w: 620, h: 560 }
                : { w: 520, h: 380 };
  return {
    w: Math.max(MIN_SIZE.w, Math.min(want.w, room.w)),
    h: Math.max(MIN_SIZE.h, Math.min(want.h, room.h)),
  };
}

/** Keep a rectangle reachable: at least its title bar stays on the stage. */
export function clampRect(rect: Rect, stage: Stage): Rect {
  const w = Math.max(MIN_SIZE.w, Math.min(rect.w, stage.w));
  const h = Math.max(
    MIN_SIZE.h,
    Math.min(rect.h, Math.max(MIN_SIZE.h, stage.h - stage.top)),
  );
  const x = Math.min(Math.max(rect.x, 48 - w), stage.w - 48);
  const y = Math.min(Math.max(rect.y, stage.top), stage.h - 40);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** Cascade position for the n-th window: diagonal steps that wrap before leaving the stage. */
export function cascadeAt(
  step: number,
  size: { w: number; h: number },
  stage: Stage,
): { x: number; y: number } {
  const originX = Math.max(16, Math.round(stage.w * 0.5 - size.w * 0.5 - 120));
  const originY = stage.top + 16;
  const roomX = Math.max(
    1,
    Math.floor((stage.w - originX - size.w - 16) / CASCADE_STEP),
  );
  const roomY = Math.max(
    1,
    Math.floor((stage.h - stage.bottom - originY - size.h) / CASCADE_STEP),
  );
  const steps = Math.max(1, Math.min(roomX, roomY, 8));
  const n = step % steps;
  const lap = Math.floor(step / steps) % 3;
  return {
    x: originX + n * CASCADE_STEP + lap * 96,
    y: originY + n * CASCADE_STEP,
  };
}

/** Grid for tiled layout: columns from the window count and the stage's aspect. */
export function tileRects(count: number, stage: Stage): Rect[] {
  if (count <= 0) return [];
  const area = {
    x: 16,
    y: stage.top + 8,
    w: stage.w - 32,
    h: Math.max(MIN_SIZE.h, stage.h - stage.top - stage.bottom - 16),
  };
  const aspect = area.w / area.h;
  let cols = Math.max(1, Math.round(Math.sqrt(count * aspect * 0.75)));
  cols = Math.min(cols, count);
  const rows = Math.ceil(count / cols);
  const cellH = (area.h - GAP * (rows - 1)) / rows;
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    // The last row spreads its windows over the full width.
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = i - row * cols;
    const cellW = (area.w - GAP * (inRow - 1)) / inRow;
    rects.push({
      x: Math.round(area.x + col * (cellW + GAP)),
      y: Math.round(area.y + row * (cellH + GAP)),
      w: Math.round(cellW),
      h: Math.round(cellH),
    });
  }
  return rects;
}

export interface OpenSpec {
  id: string;
  kind: NovaWindowKind;
  title?: string;
  phase?: WindowPhase;
  result?: boolean;
  data?: Record<string, unknown>;
  /** Do not take focus (background activity). */
  quiet?: boolean;
}

/** Open a window, or update the one with this id (data merges, it comes back from the dock and to the front). */
export function openWindow(
  state: WindowState,
  spec: OpenSpec,
  stage: Stage,
  now: number,
): WindowState {
  const existing = state.windows.find((win) => win.id === spec.id);
  if (existing) {
    const updated: NovaWin = {
      ...existing,
      title: spec.title ?? existing.title,
      phase: spec.phase ?? existing.phase,
      result: existing.result || spec.result === true,
      data: { ...existing.data, ...spec.data },
      updatedAt: now,
      doneAt:
        spec.phase === "running"
          ? null
          : spec.phase === "done" || spec.phase === "failed"
            ? (existing.doneAt ?? now)
            : existing.doneAt,
      mode:
        existing.mode === "minimized" &&
        spec.phase === "running" &&
        !existing.touched
          ? "normal"
          : existing.mode,
    };
    const windows = state.windows.map((win) =>
      win.id === spec.id ? updated : win,
    );
    return spec.quiet
      ? { ...state, windows }
      : raise({ ...state, windows }, spec.id);
  }
  const size = defaultSize(spec.kind, stage, spec.result);
  const place = spec.result
    ? {
        x: Math.round((stage.w - size.w) / 2),
        y: Math.round(
          stage.top + (stage.h - stage.top - stage.bottom - size.h) / 2,
        ),
      }
    : cascadeAt(state.cascade, size, stage);
  const win: NovaWin = {
    id: spec.id,
    kind: spec.kind,
    title: spec.title ?? "",
    mode: "normal",
    phase: spec.phase ?? "idle",
    z: state.nextZ,
    openedAt: now,
    updatedAt: now,
    doneAt: spec.phase === "done" || spec.phase === "failed" ? now : null,
    touched: false,
    result: spec.result === true,
    data: spec.data ?? {},
    ...clampRect({ ...place, ...size }, stage),
  };
  let next: WindowState = {
    ...state,
    windows: [...state.windows, win],
    nextZ: state.nextZ + 1,
    cascade: spec.result ? state.cascade : state.cascade + 1,
    focused: spec.quiet && state.focused ? state.focused : win.id,
  };
  next = enforceLimits(next);
  return next;
}

/** Bring to the front; a minimized window comes back. */
export function raise(state: WindowState, id: string): WindowState {
  const target = state.windows.find((win) => win.id === id);
  if (!target) return state;
  return {
    ...state,
    focused: id,
    nextZ: state.nextZ + 1,
    windows: state.windows.map((win) =>
      win.id === id
        ? {
            ...win,
            z: state.nextZ,
            mode: win.mode === "minimized" ? "normal" : win.mode,
          }
        : win,
    ),
  };
}

/** Focus by the owner: also marks it touched, so it no longer settles away. */
export function focusWindow(state: WindowState, id: string): WindowState {
  return touch(raise(state, id), id);
}

export function touch(state: WindowState, id: string): WindowState {
  return {
    ...state,
    windows: state.windows.map((win) =>
      win.id === id ? { ...win, touched: true } : win,
    ),
  };
}

/** The window that should have focus after `gone` leaves: the highest visible one. */
function topVisible(windows: NovaWin[], except?: string): string | null {
  return (
    windows
      .filter((win) => win.id !== except && win.mode !== "minimized")
      .sort((a, b) => b.z - a.z)[0]?.id ?? null
  );
}

export function closeWindow(state: WindowState, id: string): WindowState {
  const windows = state.windows.filter((win) => win.id !== id);
  return {
    ...state,
    windows,
    focused: state.focused === id ? topVisible(windows) : state.focused,
    cascade: windows.length ? state.cascade : 0,
    mission: windows.length ? state.mission : false,
  };
}

export function minimizeWindow(state: WindowState, id: string): WindowState {
  const windows = state.windows.map((win) =>
    win.id === id ? { ...win, mode: "minimized" as const, touched: true } : win,
  );
  return {
    ...state,
    windows,
    focused: state.focused === id ? topVisible(windows, id) : state.focused,
  };
}

export function toggleMaximize(state: WindowState, id: string): WindowState {
  return touch(
    {
      ...raise(state, id),
      windows: raise(state, id).windows.map((win) =>
        win.id === id
          ? {
              ...win,
              mode:
                win.mode === "maximized"
                  ? ("normal" as const)
                  : ("maximized" as const),
            }
          : win,
      ),
    },
    id,
  );
}

export function moveWindow(
  state: WindowState,
  id: string,
  rect: Partial<Rect>,
  stage: Stage,
): WindowState {
  return {
    ...state,
    windows: state.windows.map((win) =>
      win.id === id
        ? {
            ...win,
            ...clampRect(
              { x: win.x, y: win.y, w: win.w, h: win.h, ...rect },
              stage,
            ),
            mode: win.mode === "maximized" ? ("normal" as const) : win.mode,
            touched: true,
          }
        : win,
    ),
    // Dragging a window out of the grid means the owner wants to place things freely.
    layout: state.layout,
  };
}

/** Mark running windows finished (the turn ended). Failed stays failed. */
export function finishRunning(state: WindowState, now: number): WindowState {
  return {
    ...state,
    windows: state.windows.map((win) =>
      win.phase === "running"
        ? { ...win, phase: "done" as const, doneAt: now }
        : win,
    ),
  };
}

/**
 * Housekeeping on a timer: finished, untouched activity windows go to the dock after SETTLE_MS; a window that
 * has been in the dock for long is closed so the dock never fills up.
 */
export function settle(state: WindowState, now: number): WindowState {
  let changed = false;
  const windows: NovaWin[] = [];
  for (const win of state.windows) {
    const finished = win.phase === "done" || win.phase === "failed";
    if (
      finished &&
      !win.touched &&
      !win.result &&
      win.kind !== "video" &&
      win.mode !== "minimized" &&
      win.doneAt !== null &&
      now - win.doneAt >= SETTLE_MS
    ) {
      windows.push({ ...win, mode: "minimized" });
      changed = true;
      continue;
    }
    if (
      win.mode === "minimized" &&
      !win.touched &&
      win.doneAt !== null &&
      now - win.doneAt >= SETTLE_MS * 15
    ) {
      changed = true;
      continue;
    }
    windows.push(win);
  }
  if (!changed) return state;
  return {
    ...state,
    windows,
    focused:
      state.focused &&
      windows.some((w) => w.id === state.focused && w.mode !== "minimized")
        ? state.focused
        : topVisible(windows),
  };
}

/**
 * At most MAX_LIVE live windows on screen (the oldest finished ones go to the dock first, then the oldest) and
 * at most MAX_WINDOWS windows in all (the oldest untouched finished ones close).
 */
export function enforceLimits(state: WindowState): WindowState {
  let windows = [...state.windows];
  const visibleLive = () =>
    windows.filter((win) => isLive(win) && win.mode !== "minimized");
  while (visibleLive().length > MAX_LIVE) {
    const candidates = visibleLive()
      .filter((win) => win.id !== state.focused)
      .sort(
        (a, b) =>
          Number(a.phase === "running") - Number(b.phase === "running") ||
          a.updatedAt - b.updatedAt,
      );
    const victim = candidates[0];
    if (!victim) break;
    windows = windows.map((win) =>
      win.id === victim.id ? { ...win, mode: "minimized" } : win,
    );
  }
  while (windows.length > MAX_WINDOWS) {
    const victim = [...windows]
      .filter((win) => win.id !== state.focused)
      .sort(
        (a, b) =>
          Number(a.touched) - Number(b.touched) ||
          Number(a.phase === "running") - Number(b.phase === "running") ||
          a.updatedAt - b.updatedAt,
      )[0];
    if (!victim) break;
    windows = windows.filter((win) => win.id !== victim.id);
  }
  return { ...state, windows };
}

/** Rectangles to draw: tiled windows get grid cells (in z order of opening), floating ones keep their own. */
export function layoutRects(
  state: WindowState,
  stage: Stage,
): Map<string, Rect> {
  const visible = state.windows.filter((win) => win.mode !== "minimized");
  const rects = new Map<string, Rect>();
  if (state.layout === "tile" || state.mission) {
    // Mission control shows every window, the ones in the dock too.
    const pool = state.mission ? state.windows : visible;
    const ordered = [...pool].sort((a, b) => a.openedAt - b.openedAt);
    // Mission control steps back: the same grid with wider margins, so every tile reads as a thumbnail.
    const room = state.mission
      ? {
          ...stage,
          top: stage.top + 24,
          bottom: stage.bottom + 8,
          w: stage.w,
        }
      : stage;
    tileRects(ordered.length, room).forEach((rect, i) =>
      rects.set(ordered[i]!.id, rect),
    );
    return rects;
  }
  for (const win of visible)
    rects.set(
      win.id,
      win.mode === "maximized"
        ? {
            x: 12,
            y: stage.top,
            w: stage.w - 24,
            h: Math.max(MIN_SIZE.h, stage.h - stage.top - stage.bottom),
          }
        : { x: win.x, y: win.y, w: win.w, h: win.h },
    );
  return rects;
}
