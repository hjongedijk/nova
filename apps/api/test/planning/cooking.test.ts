import { describe, expect, it, vi } from "vitest";
import { CookingController } from "../../src/planning/cooking.controller.js";
import type { PlanningService } from "../../src/planning/planning.service.js";

describe("cooking timer", () => {
  it("uses the existing persisted timer service with a bounded step label", () => {
    const setTimer = vi.fn(() => ({ timer: { id: "one" } }));
    const controller = new CookingController({
      setTimer,
    } as unknown as PlanningService);
    expect(controller.setStepTimer({ minutes: 12, step: 3 })).toEqual({
      timer: { id: "one" },
    });
    expect(setTimer).toHaveBeenCalledWith({
      seconds: 720,
      label: "Kookstap 3",
    });
    expect(() => controller.setStepTimer({ minutes: 0, step: 3 })).toThrow();
    expect(() => controller.setStepTimer({ minutes: 12.5, step: 3 })).toThrow();
    expect(() => controller.setStepTimer({ minutes: 12, step: 31 })).toThrow();
  });
});
