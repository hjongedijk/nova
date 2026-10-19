import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// This unit runner does not compile Svelte runes; keep the store's plain value.
vi.stubGlobal("$state", <T>(value: T): T => value);
const { showToast, toasts, dismissToast } = await import("./toasts.svelte.ts");

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  toasts.items.splice(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("persistent service warnings", () => {
  it("keeps one warning when speech retries report the same failure", () => {
    for (let i = 0; i < 5; i++)
      showToast({
        severity: "warning",
        title: "Speech unavailable",
        detail: "Retry later",
      });
    expect(toasts.items).toHaveLength(1);
  });

  it("preserves distinct failures and allows a dismissed warning to return", () => {
    showToast({
      severity: "warning",
      title: "Speech unavailable",
      detail: "Network",
    });
    const id = toasts.items[0]!.id;
    showToast({
      severity: "warning",
      title: "Speech unavailable",
      detail: "Microphone",
    });
    expect(toasts.items).toHaveLength(2);
    dismissToast(id);
    showToast({
      severity: "warning",
      title: "Speech unavailable",
      detail: "Network",
    });
    expect(toasts.items).toHaveLength(2);
    expect(toasts.items[0]!.id).not.toBe(id);
  });

  it("keeps repeated information events and their automatic dismissal", () => {
    showToast({ severity: "info", title: "Note saved" });
    showToast({ severity: "info", title: "Note saved" });
    expect(toasts.items).toHaveLength(2);
    vi.advanceTimersByTime(12000);
    expect(toasts.items).toHaveLength(0);
  });
});
