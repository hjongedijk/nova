import { describe, expect, it } from "vitest";
import { findWake } from "./wake-matcher.ts";

describe("wake phrase sensitivity", () => {
  it("requires the exact Hey NOVA phrase at low sensitivity", () => {
    expect(findWake("NOVA, hoe gaat het?", "low")).toBeNull();
    expect(findWake("Hey NOVA, hoe gaat het?", "low")).toEqual({
      start: 0,
      end: 8,
    });
  });

  it("accepts NOVA and its common variants at normal sensitivity", () => {
    expect(findWake("Nova, luister", "normal")).not.toBeNull();
    expect(findWake("Hey Nowa, luister", "normal")).toBeNull();
  });

  it("accepts the broader pronunciation set at high sensitivity", () => {
    expect(findWake("Hey Nowa, luister", "high")).not.toBeNull();
  });
});
