import { describe, expect, it } from "vitest";
import { portraitPose, portraitBodyPose } from "./portrait-motion.ts";

describe("portrait gestures", () => {
  it("moves while idle without requiring a pointer or microphone", () => {
    const first = portraitPose(0, "ready", 0, 0, 0, false);
    const later = portraitPose(3, "ready", 0, 0, 0, false);
    expect(Math.abs(later[0] - first[0])).toBeGreaterThan(0.05);
    expect(Math.abs(later[1] - first[1])).toBeGreaterThan(0.01);
  });
  it("leans in when listening and adds speech gestures", () => {
    const idle = portraitPose(2, "ready", 0, 0, 0, false);
    const listening = portraitPose(2, "listening", 0, 0, 0, false);
    expect(listening[1]).toBeLessThan(idle[1]);
    expect(portraitPose(2, "speaking", 0.8, 0, 0, false)).not.toEqual(idle);
  });
  it("turns the head visibly and moves the torso independently", () => {
    const poses = Array.from(
      { length: 80 },
      (_, t) => portraitPose(t / 4, "ready", 0, 0, 0, false)[0],
    );
    expect(Math.max(...poses) - Math.min(...poses)).toBeGreaterThan(0.45);
    expect(portraitBodyPose(0, 0, false)).not.toEqual(
      portraitBodyPose(5, 0, false),
    );
    expect(portraitBodyPose(5, 1, true)).toEqual([0, 0, 0]);
  });
  it("respects reduced motion, including pointer and speech gestures", () => {
    expect(portraitPose(5, "speaking", 1, 1, 1, true)).toEqual([0, 0, 0]);
  });
});
