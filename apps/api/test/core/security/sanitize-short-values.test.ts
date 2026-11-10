import { afterEach, describe, expect, it } from "vitest";
import { sanitize } from "../../../src/core/security/sanitize.js";

describe("sanitize ignores flag-sized env values", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("does not treat COREPACK_ENABLE_AUTO_PIN=0 as a secret", () => {
    process.env.COREPACK_ENABLE_AUTO_PIN = "0";
    expect(sanitize("08:00 on 2026-11-10")).toBe("08:00 on 2026-11-10");
  });

  it("still redacts a real PIN-named value", () => {
    process.env.NOVA_TEST_PIN = "48213";
    expect(sanitize("pin 48213 used")).toBe("pin [redacted] used");
  });
});
