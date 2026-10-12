import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechResultEvent } from "./speech-types.ts";

const { ask, chat, shell } = vi.hoisted(() => ({
  ask: vi.fn(),
  chat: { busy: false, uiState: "ready", you: "", hint: "" },
  shell: {
    awaiting: false,
    draft: "",
    wakeEnabled: false,
    wakeActive: false,
  },
}));

vi.mock("#lib/stores/chat.svelte.ts", () => ({
  ask,
  chat,
  setState: vi.fn(),
}));
vi.mock("#lib/stores/chrome.svelte.ts", () => ({ showChrome: vi.fn() }));
vi.mock("#lib/stores/device.ts", () => ({ IS_MOBILE: false }));
vi.mock("#lib/stores/shell.svelte.ts", () => ({
  shell,
  secureBase: () => "https://nova.test",
}));
vi.mock("#lib/stores/toasts.svelte.ts", () => ({ showToast: vi.fn() }));
vi.mock("#lib/util/storage.ts", () => ({
  storage: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("#lib/modes/wallpaper.ts", () => ({ quietWallpaper: false }));
vi.mock("./audio.ts", () => ({ playback: { current: null } }));
vi.mock("./speaker.ts", () => ({
  isSpeaking: () => false,
  stopSpeech: vi.fn(),
}));
vi.mock("./speech-echo.ts", () => ({ isSpeechEcho: () => false }));
vi.mock("#lib/chat/ask.ts", () => ({ cancelActiveAsk: vi.fn() }));
vi.mock("./chime.ts", () => ({ chime: vi.fn() }));
vi.mock("./wake-matcher.ts", () => ({
  findWake: (text: string) => {
    const match = /hey nova/i.exec(text);
    return match ? { end: match.index + match[0].length } : null;
  },
  WAKE_LOOSE: [],
  WAKE_STRICT: [],
}));
vi.mock("./input-device.ts", () => ({
  onInputDeviceChange: vi.fn(() => () => {}),
  openSelectedInputStream: vi.fn(),
  selectedInputDevice: () => "",
  stopInputStream: vi.fn(),
}));

import { cancelAwait, handleWakeResult, setWake } from "./wake.ts";

function result(text: string, isFinal: boolean): SpeechResultEvent {
  return {
    resultIndex: 0,
    results: [{ 0: { transcript: text }, length: 1, isFinal }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ask.mockReset();
  chat.busy = false;
  shell.awaiting = false;
});

afterEach(() => {
  setWake(false);
  cancelAwait();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("wake transcript settling", () => {
  it("waits 650 ms after a final phrase before sending", () => {
    handleWakeResult(result("Hey NOVA hoe laat is het", true));
    vi.advanceTimersByTime(649);
    expect(ask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ask).toHaveBeenCalledWith("hoe laat is het", [], "voice");
  });

  it("cancels a pending final when a new interim phrase arrives", () => {
    handleWakeResult(result("Hey NOVA hoe laat", true));
    vi.advanceTimersByTime(300);
    handleWakeResult(result("Hey NOVA hoe laat is het", false));
    vi.advanceTimersByTime(350);
    expect(ask).not.toHaveBeenCalled();
    handleWakeResult(result("Hey NOVA hoe laat is het", true));
    vi.advanceTimersByTime(650);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith("hoe laat is het", [], "voice");
  });

  it("drops a pending final when wake listening stops", () => {
    handleWakeResult(result("Hey NOVA hoe laat is het", true));
    setWake(false);
    vi.advanceTimersByTime(650);
    expect(ask).not.toHaveBeenCalled();
  });
});
