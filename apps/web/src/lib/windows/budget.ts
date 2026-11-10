/*
 * How many frames each live window may ask for. The focused window gets full rate; others get less the smaller
 * they are; minimized windows and a hidden page get nothing. All of it together stays under a bandwidth budget,
 * and at most MAX_STREAMS streams run at once (the most recently used win). The server enforces its own caps; this
 * keeps the client from asking for frames it would not show.
 */
export const BUDGET = {
  fullFps: { browser: 20, screen: 15 },
  minFps: 1,
  /** Unfocused windows never exceed this share of full rate. */
  unfocusedShare: 0.5,
  missionFps: 4,
  /** All live windows together, bytes per second (estimated). */
  totalBytesPerSecond: 6_000_000,
  maxStreams: 8,
  maxWidth: 1600,
} as const;

export interface BudgetInput {
  id: string;
  kind: "browser" | "screen";
  /** CSS pixels of the picture area. */
  w: number;
  h: number;
  minimized: boolean;
  focused: boolean;
  /** Recency for the stream cap: higher wins. */
  z: number;
}

export interface StreamBudget {
  fps: number;
  maxWidth: number;
  paused: boolean;
}

/** Rough JPEG size of one frame of this width (16:10, q≈60): ~0.11 bytes per pixel. */
export const frameBytes = (width: number) =>
  Math.round(width * width * 0.625 * 0.11);

export function allocateBudget(
  windows: BudgetInput[],
  options: { hidden?: boolean; mission?: boolean; dpr?: number } = {},
): Map<string, StreamBudget> {
  const dpr = Math.min(2, Math.max(1, options.dpr ?? 1));
  const result = new Map<string, StreamBudget>();
  const paused: StreamBudget = { fps: 0, maxWidth: 0, paused: true };
  const active = windows
    .filter(
      (win) => !win.minimized && !options.hidden && win.w > 0 && win.h > 0,
    )
    .sort((a, b) => Number(b.focused) - Number(a.focused) || b.z - a.z);
  const streaming = active.slice(0, BUDGET.maxStreams);
  for (const win of windows) result.set(win.id, paused);
  if (!streaming.length) return result;
  const focusedArea = Math.max(
    ...streaming.filter((w) => w.focused).map((w) => w.w * w.h),
    ...streaming.map((w) => w.w * w.h),
  );
  const wants = streaming.map((win) => {
    const full = BUDGET.fullFps[win.kind];
    const share = win.focused
      ? 1
      : Math.min(
          BUDGET.unfocusedShare,
          Math.max(0.1, (win.w * win.h) / focusedArea),
        );
    const fps = options.mission
      ? Math.min(full, BUDGET.missionFps)
      : full * share;
    const maxWidth = Math.min(
      BUDGET.maxWidth,
      Math.max(320, Math.round(win.w * dpr)),
    );
    return { win, fps, maxWidth };
  });
  // Scale unfocused windows down first, then everyone, until the estimate fits.
  const total = () =>
    wants.reduce((sum, want) => sum + want.fps * frameBytes(want.maxWidth), 0);
  for (
    let guard = 0;
    total() > BUDGET.totalBytesPerSecond && guard < 40;
    guard++
  ) {
    const others = wants.filter(
      (want) => !want.win.focused && want.fps > BUDGET.minFps,
    );
    const targets = others.length
      ? others
      : wants.filter((want) => want.fps > BUDGET.minFps);
    if (!targets.length) {
      // Even at minimum rate it does not fit: make the pictures smaller.
      for (const want of wants)
        want.maxWidth = Math.max(320, Math.round(want.maxWidth * 0.85));
      continue;
    }
    for (const want of targets)
      want.fps = Math.max(BUDGET.minFps, want.fps * 0.8);
  }
  for (const want of wants)
    result.set(want.win.id, {
      fps: Math.round(want.fps * 10) / 10,
      maxWidth: want.maxWidth,
      paused: false,
    });
  return result;
}
