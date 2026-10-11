import { describe, expect, it } from "vitest";
import { saveWakeSensitivity, wakeSensitivity } from "./wake-preference.ts";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("novaWakeSensitivity", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("wake sensitivity preference", () => {
  it("defaults safely and persists each supported setting", () => {
    const local = storage();
    expect(wakeSensitivity(local)).toBe("normal");
    expect(saveWakeSensitivity("high", local)).toBe("high");
    expect(wakeSensitivity(local)).toBe("high");
  });

  it("ignores unknown stored values and falls back to normal", () => {
    expect(wakeSensitivity(storage("launch arbitrary instructions"))).toBe(
      "normal",
    );
  });
});
