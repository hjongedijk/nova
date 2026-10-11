import { describe, expect, it } from "vitest";
import { idleGlance } from "./orb-motion.js";
import { MOOD_LABELS, MOOD_LOOKS } from "./states.js";

describe("idle orb movement", () => {
  it("defines bounded colors and readable Dutch labels for each mood", () => {
    expect(Object.keys(MOOD_LOOKS).sort()).toEqual(
      Object.keys(MOOD_LABELS).sort(),
    );
    expect(MOOD_LABELS.happy).toBe("Blij");
    expect(MOOD_LABELS.thoughtful).toBe("Nadenkend");
    expect(MOOD_LABELS.concerned).toBe("Bezorgd");
    expect(MOOD_LABELS.enthusiastic).toBe("Enthousiast");
    for (const look of Object.values(MOOD_LOOKS)) {
      if (look.h !== undefined) expect(look.h).toBeGreaterThanOrEqual(0);
      if (look.h !== undefined) expect(look.h).toBeLessThan(360);
      if (look.glow !== undefined) expect(look.glow).toBeLessThanOrEqual(1);
    }
  });

  it("adds brief bounded glances, then returns to center", () => {
    expect(idleGlance(0)).toEqual({ x: 0, y: 0 });
    const first = idleGlance(0.5);
    expect(first.x).toBeGreaterThan(0);
    expect(Math.abs(first.x)).toBeLessThanOrEqual(0.16);
    expect(Math.abs(first.y)).toBeLessThanOrEqual(0.16);
    expect(idleGlance(1.2)).toEqual({ x: 0, y: 0 });
    expect(idleGlance(12.5).x).toBeLessThan(0);
  });
});
