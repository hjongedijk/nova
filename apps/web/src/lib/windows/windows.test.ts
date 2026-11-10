import { describe, expect, it } from "vitest";
import { allocateBudget, BUDGET, frameBytes } from "./budget.ts";
import { applyFeed, BROWSER_WINDOW, handledByWindows } from "./feed.ts";
import { decodeFrame } from "./live-client.ts";
import {
  cascadeAt,
  closeWindow,
  emptyState,
  enforceLimits,
  focusWindow,
  layoutRects,
  MAX_LIVE,
  minimizeWindow,
  moveWindow,
  openWindow,
  settle,
  SETTLE_MS,
  tileRects,
  toggleMaximize,
  type Stage,
  type WindowState,
} from "./manager.ts";
import { embedUrl, playerCommand } from "./video.ts";

const stage: Stage = { w: 1440, h: 900, top: 68, bottom: 124 };

const open = (
  state: WindowState,
  id: string,
  kind = "page" as const,
  now = 0,
) => openWindow(state, { id, kind, title: id }, stage, now);

describe("window manager", () => {
  it("opens, focuses and stacks windows in z order", () => {
    let state = open(emptyState(), "a");
    state = open(state, "b");
    expect(state.focused).toBe("b");
    const z = (id: string) => state.windows.find((w) => w.id === id)!.z;
    expect(z("b")).toBeGreaterThan(z("a"));
    state = focusWindow(state, "a");
    expect(state.focused).toBe("a");
    expect(z("a")).toBeGreaterThan(z("b"));
    expect(state.windows.find((w) => w.id === "a")!.touched).toBe(true);
  });

  it("cascades new windows so they do not cover each other exactly", () => {
    const size = { w: 600, h: 400 };
    const places = Array.from({ length: 5 }, (_, i) =>
      cascadeAt(i, size, stage),
    );
    expect(new Set(places.map((p) => `${p.x},${p.y}`)).size).toBe(5);
    for (const place of places) {
      expect(place.x + size.w).toBeLessThanOrEqual(stage.w);
      expect(place.y).toBeGreaterThanOrEqual(stage.top);
    }
  });

  it("updates a window with the same id instead of opening another", () => {
    let state = openWindow(
      emptyState(),
      { id: "x", kind: "browser", data: { url: "a" } },
      stage,
      0,
    );
    state = openWindow(
      state,
      { id: "x", kind: "browser", data: { title: "t" } },
      stage,
      5,
    );
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]!.data).toEqual({ url: "a", title: "t" });
  });

  it("minimizes to the dock, restores on focus and moves focus to the next window", () => {
    let state = open(open(emptyState(), "a"), "b");
    state = minimizeWindow(state, "b");
    expect(state.windows.find((w) => w.id === "b")!.mode).toBe("minimized");
    expect(state.focused).toBe("a");
    expect(layoutRects(state, stage).has("b")).toBe(false);
    state = focusWindow(state, "b");
    expect(state.windows.find((w) => w.id === "b")!.mode).toBe("normal");
  });

  it("maximizes, and a drag restores to a normal window inside the stage", () => {
    let state = toggleMaximize(open(emptyState(), "a"), "a");
    expect(layoutRects(state, stage).get("a")).toMatchObject({
      x: 12,
      y: stage.top,
      w: stage.w - 24,
    });
    state = moveWindow(state, "a", { x: -5000, y: -5000 }, stage);
    const win = state.windows[0]!;
    expect(win.mode).toBe("normal");
    expect(win.x + win.w).toBeGreaterThanOrEqual(48);
    expect(win.y).toBe(stage.top);
  });

  it("closing the focused window focuses the one below it", () => {
    let state = open(open(open(emptyState(), "a"), "b"), "c");
    state = closeWindow(state, "c");
    expect(state.focused).toBe("b");
    expect(state.windows.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("tiles 2 to 7 windows into a grid without overlap", () => {
    for (let n = 2; n <= 7; n++) {
      const rects = tileRects(n, stage);
      expect(rects).toHaveLength(n);
      for (const [i, a] of rects.entries())
        for (const b of rects.slice(i + 1))
          expect(
            a.x + a.w <= b.x ||
              b.x + b.w <= a.x ||
              a.y + a.h <= b.y ||
              b.y + b.h <= a.y,
          ).toBe(true);
      for (const rect of rects) {
        expect(rect.y).toBeGreaterThanOrEqual(stage.top);
        expect(rect.y + rect.h).toBeLessThanOrEqual(stage.h - stage.bottom + 1);
      }
    }
  });

  it("settles finished, untouched windows into the dock; results and videos stay", () => {
    let state = openWindow(
      emptyState(),
      { id: "t", kind: "terminal", phase: "done" },
      stage,
      0,
    );
    state = openWindow(
      state,
      { id: "r", kind: "page", phase: "done", result: true },
      stage,
      0,
    );
    state = openWindow(
      state,
      { id: "v", kind: "video", phase: "done" },
      stage,
      0,
    );
    state = openWindow(
      state,
      { id: "touched", kind: "terminal", phase: "done" },
      stage,
      0,
    );
    state = focusWindow(state, "touched");
    state = settle(state, SETTLE_MS + 1);
    const mode = (id: string) => state.windows.find((w) => w.id === id)?.mode;
    expect(mode("t")).toBe("minimized");
    expect(mode("r")).toBe("normal");
    expect(mode("v")).toBe("normal");
    expect(mode("touched")).toBe("normal");
  });

  it(`keeps at most ${MAX_LIVE} live windows on screen; the oldest finished go to the dock`, () => {
    let state = emptyState();
    for (let i = 0; i < MAX_LIVE + 3; i++)
      state = openWindow(
        state,
        { id: `b${i}`, kind: "browser", phase: i < 3 ? "done" : "running" },
        stage,
        i,
      );
    state = enforceLimits(state);
    const visible = state.windows.filter((w) => w.mode !== "minimized");
    expect(visible).toHaveLength(MAX_LIVE);
    expect(
      state.windows
        .filter((w) => w.mode === "minimized")
        .map((w) => w.id)
        .sort(),
    ).toEqual(["b0", "b1", "b2"]);
  });
});

describe("window manager, finishing and overview", () => {
  it("a window that finishes later settles from the moment it finished", () => {
    let state = openWindow(
      emptyState(),
      { id: "t", kind: "terminal", phase: "running" },
      stage,
      0,
    );
    state = openWindow(
      state,
      { id: "t", kind: "terminal", phase: "done" },
      stage,
      1000,
    );
    expect(state.windows[0]!.doneAt).toBe(1000);
    expect(settle(state, 1000 + SETTLE_MS - 1).windows[0]!.mode).toBe("normal");
    expect(settle(state, 1000 + SETTLE_MS).windows[0]!.mode).toBe("minimized");
  });

  it("mission control lays out every window, also the ones in the dock", () => {
    let state = open(open(open(emptyState(), "a"), "b"), "c");
    state = minimizeWindow(state, "b");
    expect(layoutRects(state, stage).size).toBe(2);
    expect(layoutRects({ ...state, mission: true }, stage).size).toBe(3);
  });
});

describe("multi-stream frame budget", () => {
  const live = (
    id: string,
    over: Partial<Parameters<typeof allocateBudget>[0][0]> = {},
  ) => ({
    id,
    kind: "browser" as const,
    w: 640,
    h: 400,
    minimized: false,
    focused: false,
    z: 1,
    ...over,
  });

  it("gives the focused window full rate and smaller unfocused ones less", () => {
    const budget = allocateBudget([
      live("focus", { focused: true, w: 1000, h: 640, z: 9 }),
      live("small", { w: 320, h: 200 }),
      live("min", { minimized: true }),
    ]);
    expect(budget.get("focus")!.fps).toBe(BUDGET.fullFps.browser);
    expect(budget.get("small")!.fps).toBeLessThan(
      BUDGET.fullFps.browser * BUDGET.unfocusedShare,
    );
    expect(budget.get("small")!.paused).toBe(false);
    expect(budget.get("min")!.paused).toBe(true);
  });

  it("stays under the total bandwidth with many windows and caps the number of streams", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      live(`w${i}`, { focused: i === 0, z: i, w: 900, h: 560 }),
    );
    const budget = allocateBudget(many, { dpr: 2 });
    const running = [...budget.entries()].filter(([, b]) => !b.paused);
    expect(running).toHaveLength(BUDGET.maxStreams);
    const total = running.reduce(
      (sum, [, b]) => sum + b.fps * frameBytes(b.maxWidth),
      0,
    );
    expect(total).toBeLessThanOrEqual(BUDGET.totalBytesPerSecond);
    // The focused window keeps the best rate of all.
    const focused = budget.get("w0")!.fps;
    expect(running.every(([, b]) => b.fps <= focused)).toBe(true);
  });

  it("pauses everything while the page is hidden; mission control lowers every tile", () => {
    const windows = [live("a", { focused: true }), live("b")];
    expect(
      [...allocateBudget(windows, { hidden: true }).values()].every(
        (b) => b.paused,
      ),
    ).toBe(true);
    const mission = allocateBudget(windows, { mission: true });
    expect([...mission.values()].every((b) => b.fps <= BUDGET.missionFps)).toBe(
      true,
    );
  });
});

describe("chat stream → windows", () => {
  const start = (name: string, preview?: object) =>
    ({
      type: "tool_start",
      data: { name, ...(preview ? { preview } : {}) },
    }) as const;
  const result = (name: string, preview?: object, ok = true) =>
    ({
      type: "tool_result",
      data: { name, ok, ...(preview ? { preview } : {}) },
    }) as const;

  it("feeds every browser step into one live browser window with the click overlay", () => {
    let state = applyFeed(
      emptyState(),
      start("browser_open", { kind: "page", url: "https://a.example/" }),
      stage,
      0,
    );
    state = applyFeed(
      state,
      result("browser_click", {
        kind: "page",
        url: "https://a.example/b",
        title: "B",
        action: { kind: "click", x: 0.5, y: 0.25 },
      }),
      stage,
      10,
    );
    expect(state.windows).toHaveLength(1);
    const win = state.windows[0]!;
    expect(win).toMatchObject({
      id: BROWSER_WINDOW,
      kind: "browser",
      phase: "running",
    });
    expect(win.data).toMatchObject({
      url: "https://a.example/b",
      action: { kind: "click", x: 0.5, y: 0.25, at: 10 },
    });
  });

  it("opens the final page large when the turn ends", () => {
    let state = applyFeed(
      emptyState(),
      start("browser_open", { url: "https://a.example/" }),
      stage,
      0,
    );
    state = applyFeed(
      state,
      result("browser_read", { url: "https://a.example/x", title: "X" }),
      stage,
      1,
    );
    state = applyFeed(state, { type: "turn_end" }, stage, 2);
    const final = state.windows.find((w) => w.result);
    expect(final).toMatchObject({
      kind: "page",
      data: { url: "https://a.example/x", snapshotOf: BROWSER_WINDOW },
    });
    expect(state.windows.find((w) => w.id === BROWSER_WINDOW)!.phase).toBe(
      "done",
    );
    // A later turn without browser steps opens no second result.
    expect(
      applyFeed(state, { type: "turn_end" }, stage, 3).windows,
    ).toHaveLength(2);
  });

  it("gives each command its own terminal window, side by side", () => {
    let state = emptyState();
    for (const host of ["vm100", "vm200"])
      state = applyFeed(
        state,
        {
          type: "terminal",
          data: {
            id: `term-${host}`,
            phase: "start",
            host,
            command: "uptime",
            tool: "termix_run_command",
          },
        },
        stage,
        0,
      );
    state = applyFeed(
      state,
      {
        type: "terminal",
        data: {
          id: "term-vm100",
          phase: "end",
          ok: true,
          exitCode: 0,
          durationMs: 120,
        },
      },
      stage,
      5,
    );
    expect(state.windows.map((w) => w.title)).toEqual([
      "ssh vm100",
      "ssh vm200",
    ]);
    expect(state.windows[0]).toMatchObject({
      phase: "done",
      data: { exitCode: 0, durationMs: 120 },
    });
    expect(state.windows[1]!.phase).toBe("running");
    expect(state.windows[0]!.x).not.toBe(state.windows[1]!.x);
  });

  it("opens what window_open asked for and ignores unknown kinds", () => {
    let state = applyFeed(
      emptyState(),
      {
        type: "window",
        data: {
          id: "video-1",
          kind: "video",
          title: "Dune",
          video: { provider: "youtube", id: "n9xhJrPXop4" },
        },
      },
      stage,
      0,
    );
    expect(state.windows[0]).toMatchObject({ kind: "video", title: "Dune" });
    state = applyFeed(
      state,
      { type: "window", data: { id: "x", kind: "evil" as never } },
      stage,
      0,
    );
    expect(state.windows).toHaveLength(1);
  });

  it("knows which tools the small activity windows can skip", () => {
    expect(handledByWindows("browser_click")).toBe(true);
    expect(handledByWindows("termix_run_command")).toBe(true);
    expect(handledByWindows("browser_status")).toBe(false);
    expect(handledByWindows("web_search")).toBe(false);
  });
});

describe("live frames and players", () => {
  it("decodes the length-prefixed frame header", () => {
    const head = new TextEncoder().encode(
      JSON.stringify({ key: "w1", seq: 2, width: 4, height: 3 }),
    );
    const buffer = new Uint8Array(4 + head.length + 3);
    new DataView(buffer.buffer).setUint32(0, head.length);
    buffer.set(head, 4);
    buffer.set([1, 2, 3], 4 + head.length);
    const frame = decodeFrame(buffer.buffer);
    expect(frame?.header).toMatchObject({ key: "w1", seq: 2 });
    expect(frame?.jpeg.size).toBe(3);
    expect(decodeFrame(new ArrayBuffer(3))).toBeNull();
  });

  it("embeds YouTube without cookies and Vimeo without tracking", () => {
    expect(
      embedUrl(
        { provider: "youtube", id: "n9xhJrPXop4", start: 30 },
        "https://nova",
      ),
    ).toMatch(
      /^https:\/\/www\.youtube-nocookie\.com\/embed\/n9xhJrPXop4\?.*start=30/,
    );
    expect(
      embedUrl({ provider: "youtube", id: "bad id" }, "https://nova"),
    ).toBeNull();
    expect(embedUrl({ provider: "vimeo", id: "76979871" }, "")).toMatch(
      /player\.vimeo\.com\/video\/76979871\?.*dnt=1/,
    );
    expect(playerCommand("youtube", false)).toContain("pauseVideo");
  });
});
