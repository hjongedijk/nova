/*
 * Where the activity windows go. They flank the entity in two lanes (newest step alternating right,
 * left), stay inside the free rectangle between the header, the HUD columns and the stage/composer,
 * and never stack past it: what does not fit (or is older than the fourth) folds into the chip row.
 * On a phone there is one compact strip: the newest window at full width, the rest as chips.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  index: number;
  x: number;
  y: number;
  width: number;
  /** The tallest the window may be here; its body scrolls or clips past it. */
  maxHeight: number;
  side: "left" | "right" | "strip";
}

export interface LayoutInput {
  /** The free area for windows (already inset from header, columns, stage and composer). */
  bounds: Rect;
  /** The entity's centre and radius in page pixels. */
  core: { x: number; y: number; r: number };
  /** Measured (or estimated) height per window, oldest first. */
  heights: number[];
  width: number;
  gap: number;
  /** Height the chip row needs when it is shown. */
  chipHeight: number;
  compact: boolean;
  maxVisible?: number;
}

export interface Layout {
  placements: Placement[];
  /** How many of the oldest windows are folded into chips. */
  folded: number;
  /** Where the chip row starts (top-left), or null when there are no chips. */
  chips: { x: number; y: number; width: number } | null;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function layoutActivity(input: LayoutInput): Layout {
  const { bounds, core, heights, gap, compact } = input;
  const count = heights.length;
  const areaWidth = Math.max(0, bounds.right - bounds.left);
  if (!count || areaWidth < 120 || bounds.bottom - bounds.top < 60)
    return { placements: [], folded: count, chips: null };

  if (compact) {
    const folded = count - 1;
    const chips =
      folded > 0 ? { x: bounds.left, y: bounds.top, width: areaWidth } : null;
    const top = bounds.top + (chips ? input.chipHeight + gap : 0);
    return {
      placements: [
        {
          index: count - 1,
          x: bounds.left,
          y: top,
          width: areaWidth,
          maxHeight: Math.max(60, bounds.bottom - top),
          side: "strip",
        },
      ],
      folded,
      chips,
    };
  }

  const width = Math.min(input.width, areaWidth);
  const max = Math.max(1, input.maxVisible ?? 4);
  // Lanes hug the entity's flanks, pulled in over its glow, and are pushed back inside the bounds.
  const reach = core.r * 0.55 + gap;
  let rightX = clamp(core.x + reach, bounds.left, bounds.right - width);
  let leftX = clamp(core.x - reach - width, bounds.left, bounds.right - width);
  let lanes = 2;
  if (rightX < leftX + width + gap) {
    leftX = bounds.left;
    rightX = bounds.right - width;
    if (rightX < leftX + width + gap) {
      lanes = 1;
      leftX = rightX = clamp(
        core.x - width / 2,
        bounds.left,
        bounds.right - width,
      );
    }
  }

  for (let visible = Math.min(max, count); visible >= 1; visible--) {
    const folded = count - visible;
    const top = bounds.top + (folded ? input.chipHeight + gap : 0);
    const room = bounds.bottom - top;
    const shown = heights.slice(folded);
    // Oldest first: index 0 right, 1 left, 2 right, ... so the newest sits beside the previous one.
    const laneOf = (i: number) => (lanes === 1 ? 0 : i % 2 === 0 ? 0 : 1);
    const totals = [0, 0];
    const counts = [0, 0];
    shown.forEach((height, i) => {
      const lane = laneOf(i);
      totals[lane]! += (counts[lane]! ? gap : 0) + height;
      counts[lane]!++;
    });
    if (Math.max(...totals) > room && visible > 1) continue;
    const cursor = totals.map((total) =>
      clamp(core.y - total / 2, top, bounds.bottom - total),
    );
    const placements = shown.map((height, i): Placement => {
      const lane = laneOf(i);
      const y = cursor[lane]!;
      cursor[lane] = y + height + gap;
      return {
        index: folded + i,
        x: lane === 0 ? rightX : leftX,
        y,
        width,
        maxHeight: Math.max(60, room),
        side: lanes === 1 ? "right" : lane === 0 ? "right" : "left",
      };
    });
    const chips = folded
      ? {
          x: bounds.left,
          y: bounds.top,
          width: areaWidth,
        }
      : null;
    return { placements, folded, chips };
  }
  return { placements: [], folded: count, chips: null };
}
