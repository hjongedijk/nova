import { describe, expect, it } from "vitest";
import {
  activityKind,
  activityLabel,
  emptyActivity,
  formatDuration,
  KEEP_MAX,
  LINGER_MS,
  monogram,
  readPreview,
  reduceActivity,
  type ActivityEvent,
  type ActivityState,
} from "./activity.ts";
import { layoutActivity } from "./activity-layout.ts";

const run = (events: [ActivityEvent, number][], start = emptyActivity()) =>
  events.reduce<ActivityState>(
    (state, [event, now]) => reduceActivity(state, event, now),
    start,
  );

const search = {
  name: "web_search",
  step: 1,
  preview: { kind: "search", query: "ijsvogel" },
};

describe("activity state machine", () => {
  it("opens a running window per tool step and settles it on the result", () => {
    const state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: search }, 10],
      [
        {
          type: "tool_result",
          data: {
            name: "web_search",
            step: 1,
            ok: true,
            preview: {
              kind: "search",
              results: [{ title: "IJsvogel", domain: "vogelbescherming.nl" }],
              total: 1,
            },
          },
        },
        900,
      ],
    ]);
    expect(state.items).toHaveLength(1);
    const [item] = state.items;
    expect(item).toMatchObject({
      phase: "done",
      label: "Zoeken op het web",
      kind: "search",
      startedAt: 10,
      endedAt: 900,
      expiresAt: null,
    });
    // The query from the start survives the result preview.
    expect(item!.preview).toMatchObject({ query: "ijsvogel", total: 1 });
  });

  it("marks a failed step and keeps running steps apart by step number", () => {
    const state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: { name: "web_read", step: 1 } }, 1],
      [{ type: "tool_start", data: { name: "web_read", step: 2 } }, 2],
      [
        { type: "tool_result", data: { name: "web_read", step: 2, ok: false } },
        3,
      ],
      [
        {
          type: "tool_result",
          data: { name: "ha_turn_on", step: 2, ok: true, verified: false },
        },
        4,
      ],
    ]);
    expect(state.items.map((item) => item.phase)).toEqual([
      "running",
      "failed",
    ]);
  });

  it("works without step numbers and ignores bookkeeping tools", () => {
    const state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: { name: "nova_tools_search" } }, 1],
      [{ type: "tool_start", data: { name: "termix_run_command" } }, 2],
      [{ type: "tool_start", data: { name: "termix_run_command" } }, 3],
      [
        { type: "tool_result", data: { name: "termix_run_command", ok: true } },
        4,
      ],
    ]);
    expect(state.items.map((item) => [item.step, item.phase])).toEqual([
      [1, "running"],
      [2, "done"],
    ]);
  });

  it("lingers after the answer, then expires; pinned windows stay", () => {
    let state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: search }, 1],
      [{ type: "tool_start", data: { name: "weather_forecast", step: 2 } }, 2],
      [{ type: "turn_end" }, 1000],
    ]);
    // A step still running when the turn ends is settled, not left spinning.
    expect(state.items.map((item) => item.phase)).toEqual(["done", "done"]);
    expect(state.items[0]!.expiresAt).toBe(1000 + LINGER_MS);
    state = reduceActivity(
      state,
      { type: "pin", id: state.items[1]!.id },
      2000,
    );
    state = reduceActivity(state, { type: "tick" }, 1000 + LINGER_MS + 1);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.pinned).toBe(true);
    // Unpinned again: a fresh linger, not an instant vanish.
    state = reduceActivity(
      state,
      { type: "pin", id: state.items[0]!.id },
      9000,
    );
    expect(state.items[0]!.expiresAt).toBe(9000 + LINGER_MS);
  });

  it("fails running steps when the turn fails", () => {
    const state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: search }, 1],
      [{ type: "turn_end", failed: true }, 5],
    ]);
    expect(state.items[0]!.phase).toBe("failed");
  });

  it("holds a window while it is looked at", () => {
    let state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: search }, 1],
      [{ type: "turn_end" }, 10],
    ]);
    const id = state.items[0]!.id;
    state = reduceActivity(state, { type: "hold", id, held: true }, 20);
    state = reduceActivity(state, { type: "tick" }, 10 + LINGER_MS * 3);
    expect(state.items).toHaveLength(1);
    state = reduceActivity(state, { type: "hold", id, held: false }, 50_000);
    expect(state.items[0]!.expiresAt).toBe(50_000 + LINGER_MS);
  });

  it("clears the previous turn except pinned windows, and dismisses on request", () => {
    let state = run([
      [{ type: "turn_start" }, 0],
      [{ type: "tool_start", data: search }, 1],
      [{ type: "tool_start", data: { name: "calendar_events", step: 2 } }, 2],
    ]);
    state = reduceActivity(state, { type: "pin", id: state.items[0]!.id }, 3);
    state = reduceActivity(state, { type: "turn_start" }, 4);
    expect(state.items).toHaveLength(1);
    expect(state.turn).toBe(2);
    state = reduceActivity(
      state,
      { type: "dismiss", id: state.items[0]!.id },
      5,
    );
    expect(state.items).toHaveLength(0);
  });

  it("keeps at most KEEP_MAX windows (50 steps in one turn)", () => {
    const events: [ActivityEvent, number][] = [[{ type: "turn_start" }, 0]];
    for (let step = 1; step <= 50; step++)
      events.push([
        { type: "tool_start", data: { name: "web_search", step } },
        step,
      ]);
    const state = run(events);
    expect(state.items).toHaveLength(KEEP_MAX);
    expect(state.items.at(-1)!.step).toBe(50);
  });

  it("rejects malformed previews", () => {
    expect(readPreview({ kind: "evil", html: "<b>" })).toBeNull();
    expect(readPreview("x")).toBeNull();
    expect(
      readPreview({ kind: "search", results: [{ title: 5 }, { title: "ok" }] }),
    ).toEqual({ kind: "search", results: [{ title: "ok", domain: "" }] });
  });

  it("labels tools in Dutch and picks a window kind", () => {
    expect(activityLabel("termix_run_command")).toBe("Opdracht op server");
    expect(activityLabel("ha_turn_on")).toBe("Huis bedienen");
    expect(activityLabel("some_new_tool")).toBe("Some new tool");
    expect(activityKind("proxmox_guests", null)).toBe("data");
    expect(activityKind("notes_save", null)).toBe("generic");
    expect(activityKind("web_search", { kind: "status", message: "x" })).toBe(
      "search",
    );
    expect(formatDuration(420)).toBe("0,4 s");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
    expect(monogram("www.vogelbescherming.nl")).toBe("V");
    expect(monogram("東京.jp")).toBe("東");
    expect(monogram("")).toBe("·");
  });
});

describe("activity layout", () => {
  const base = {
    bounds: { left: 340, top: 80, right: 1580, bottom: 860 },
    core: { x: 960, y: 430, r: 200 },
    width: 320,
    gap: 14,
    chipHeight: 30,
    compact: false,
  };
  const overlaps = (
    a: { x: number; y: number; width: number },
    ah: number,
    b: { x: number; y: number; width: number },
    bh: number,
  ) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + bh &&
    b.y < a.y + ah;

  it("flanks the entity in two lanes inside the bounds without overlap", () => {
    const heights = [140, 180, 120, 160];
    const { placements, folded, chips } = layoutActivity({ ...base, heights });
    expect(folded).toBe(0);
    expect(chips).toBeNull();
    expect(placements.map((place) => place.side)).toEqual([
      "right",
      "left",
      "right",
      "left",
    ]);
    for (const place of placements) {
      expect(place.x).toBeGreaterThanOrEqual(base.bounds.left);
      expect(place.x + place.width).toBeLessThanOrEqual(base.bounds.right);
      expect(place.y).toBeGreaterThanOrEqual(base.bounds.top);
      expect(place.y + heights[place.index]!).toBeLessThanOrEqual(
        base.bounds.bottom,
      );
    }
    for (const a of placements)
      for (const b of placements)
        if (a !== b)
          expect(overlaps(a, heights[a.index]!, b, heights[b.index]!)).toBe(
            false,
          );
  });

  it("folds everything past four, and more when the area is short", () => {
    const six = layoutActivity({
      ...base,
      heights: [100, 100, 100, 100, 100, 100],
    });
    expect(six.folded).toBe(2);
    expect(six.placements.map((place) => place.index)).toEqual([2, 3, 4, 5]);
    expect(six.chips).not.toBeNull();
    expect(six.placements[0]!.y).toBeGreaterThanOrEqual(base.bounds.top + 30);

    const short = layoutActivity({
      ...base,
      bounds: { ...base.bounds, bottom: 400 },
      heights: [200, 200, 200, 200],
    });
    expect(short.placements.length).toBeLessThan(4);
    expect(short.folded).toBe(4 - short.placements.length);
  });

  it("uses one lane at 1280×720 when two do not fit", () => {
    const { placements } = layoutActivity({
      ...base,
      bounds: { left: 340, top: 80, right: 940, bottom: 600 },
      core: { x: 640, y: 330, r: 150 },
      width: 320,
      heights: [120, 120],
    });
    expect(new Set(placements.map((place) => place.x)).size).toBe(1);
  });

  it("is a single strip on a phone", () => {
    const strip = layoutActivity({
      ...base,
      compact: true,
      bounds: { left: 12, top: 200, right: 378, bottom: 560 },
      heights: [100, 100, 100],
    });
    expect(strip.placements).toEqual([
      expect.objectContaining({ index: 2, side: "strip", x: 12, width: 366 }),
    ]);
    expect(strip.folded).toBe(2);
  });

  it("shows nothing in a degenerate area", () => {
    expect(
      layoutActivity({
        ...base,
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
        heights: [100],
      }).placements,
    ).toEqual([]);
  });
});
