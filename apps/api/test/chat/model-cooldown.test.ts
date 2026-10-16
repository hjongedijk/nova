import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCooldown } from "../../src/chat/model-cooldown.js";

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("model cooldown", () => {
  it("blocks a failing model until its delay has passed, then allows one probe", () => {
    const c = new ModelCooldown();
    c.failure("a");
    expect(c.canAcquire("a")).toBe(false);
    expect(c.acquire("a")).toBeUndefined();
    vi.advanceTimersByTime(61_000);
    const lease = c.acquire("a");
    expect(lease).toBeDefined();
    expect(c.acquire("a")).toBeUndefined(); // one probe at a time
    lease!.release();
    expect(c.canAcquire("a")).toBe(true);
  });

  it("picks the candidate that recovers first as a last resort", () => {
    const c = new ModelCooldown();
    c.failure("slow");
    c.failure("slow");
    c.failure("slow"); // 4 minutes
    c.failure("quick"); // 1 minute
    expect(c.canAcquire("slow")).toBe(false);
    expect(c.canAcquire("quick")).toBe(false);
    expect(c.soonest(["slow", "quick"])).toBe("quick");
    expect(c.soonest(["slow", "quick", "fresh"])).toBe("fresh"); // a model with no failures is always preferred
  });

  it("force takes one lease despite the cooldown but never two", () => {
    const c = new ModelCooldown();
    c.failure("m");
    const lease = c.force("m");
    expect(lease).toBeDefined();
    expect(c.force("m")).toBeUndefined();
    expect(c.soonest(["m"])).toBeUndefined(); // already being probed
    lease!.release();
    expect(c.force("m")).toBeDefined();
  });

  it("success clears the state", () => {
    const c = new ModelCooldown();
    c.failure("m");
    c.success("m");
    expect(c.canAcquire("m")).toBe(true);
  });
});
