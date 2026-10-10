import { afterEach, describe, expect, it, vi } from "vitest";
// Runtime import keeps browser DOM types outside the API compiler's rootDir.
const modulePath = new URL(
  "../../../web/src/lib/api/pin-session.ts",
  import.meta.url,
).pathname;
const { getPin, setPin, PIN_SESSION_MS } = (await import(modulePath)) as {
  getPin(): string;
  setPin(value: string): void;
  PIN_SESSION_MS: number;
};

afterEach(() => {
  setPin("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the browser PIN session", () => {
  it("expires without extending its lifetime on reads", () => {
    vi.useFakeTimers();
    setPin("4321");
    vi.advanceTimersByTime(PIN_SESSION_MS - 1);
    expect(getPin()).toBe("4321");
    vi.advanceTimersByTime(1);
    expect(getPin()).toBe("");
  });
  it("erases legacy local storage and never writes the credential", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { removeItem });
    setPin("4321");
    expect(removeItem).toHaveBeenCalledWith("novaPin");
    expect(getPin()).toBe("4321");
    setPin("");
    expect(getPin()).toBe("");
  });
  it("works when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => setPin("4321")).not.toThrow();
    expect(getPin()).toBe("4321");
  });
});
