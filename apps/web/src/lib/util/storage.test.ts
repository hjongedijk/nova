import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "./storage.ts";

afterEach(() => vi.unstubAllGlobals());
function fixture(values: Record<string, string>) {
  const entries = new Map(Object.entries(values));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
  return entries;
}
describe("Nova browser preference migration", () => {
  it.each([
    ["novaSessionId", "jarvisSessionId", "existing-conversation"],
    ["novaWake", "jarvisWake", "off"],
    ["novaPanels", "jarvisPanels", "off"],
    ["novaVoiceAlerts", "jarvisVoiceAlerts", "on"],
  ])("preserves %s and rollback copy", (current, legacy, value) => {
    const entries = fixture({ [legacy]: value });
    expect(storage.get(current, "missing")).toBe(value);
    expect(entries.get(current)).toBe(value);
    storage.set(current, "changed");
    expect(entries.get(legacy)).toBe("changed");
    expect(storage.get(current, "missing")).toBe("changed");
  });
  it("prefers current values over legacy values", () => {
    fixture({ novaWake: "off", jarvisWake: "on" });
    expect(storage.get("novaWake", "on")).toBe("off");
  });
  it("reads legacy values when migration writes are blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "jarvisWake" ? "off" : null),
      setItem: () => {
        throw Error("blocked");
      },
    });
    expect(storage.get("novaWake", "on")).toBe("off");
    expect(() => storage.set("novaWake", "on")).not.toThrow();
  });
});
