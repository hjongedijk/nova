import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechResultEvent } from "./speech-types.ts";

const {
  ask,
  chat,
  shell,
  selectedInputDevice,
  openSelectedInputStream,
  onInputDeviceChange,
  stopInputStream,
  speaking,
  stopSpeech,
} = vi.hoisted(() => ({
  speaking: { now: false, text: "" },
  stopSpeech: vi.fn(),
  selectedInputDevice: vi.fn(() => ""),
  openSelectedInputStream: vi.fn(),
  onInputDeviceChange: vi.fn<(listener: () => void) => () => void>(
    () => () => {},
  ),
  stopInputStream: vi.fn(),
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
  isSpeaking: () => speaking.now,
  speakingText: () => speaking.text,
  stopSpeech,
}));
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
  onInputDeviceChange,
  openSelectedInputStream,
  selectedInputDevice,
  stopInputStream,
}));

import { showToast } from "#lib/stores/toasts.svelte.ts";

import {
  afterSpeech,
  cancelAwait,
  FOLLOW_UP_MS,
  FOLLOW_UP_QUESTION_MS,
  handleWakeResult,
  initWake,
  noteSpoken,
  setFollowUpGuard,
  setFollowUpListener,
  setWake,
} from "./wake.ts";

function result(text: string, isFinal: boolean): SpeechResultEvent {
  return {
    resultIndex: 0,
    results: [{ 0: { transcript: text }, length: 1, isFinal }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ask.mockReset();
  vi.mocked(showToast).mockClear();
  chat.busy = false;
  shell.awaiting = false;
  selectedInputDevice.mockReturnValue("");
  openSelectedInputStream.mockReset();
  stopInputStream.mockReset();
  onInputDeviceChange.mockClear();
  stopSpeech.mockClear();
  speaking.now = false;
  speaking.text = "";
  shell.wakeEnabled = false;
  shell.wakeActive = false;
  setFollowUpListener(null);
  setFollowUpGuard(() => true);
});

afterEach(() => {
  setWake(false);
  cancelAwait();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

describe("wake microphone reconnects", () => {
  function setup() {
    const instances: Array<{
      onstart: (() => void) | null;
      onend: (() => void) | null;
      onerror: ((event: { error: string }) => void) | null;
      onresult: ((event: SpeechResultEvent) => void) | null;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    class Recognition {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onresult: ((event: SpeechResultEvent) => void) | null = null;
      start = vi.fn(() => this.onstart?.());
      stop = vi.fn(() => this.onend?.());
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        isSecureContext: true,
        SpeechRecognition: Recognition,
      }),
    );
    selectedInputDevice.mockReturnValue("saved-mic");
    const cleanup = initWake();
    return { instances, cleanup };
  }
  const stream = (readyState = "live") => {
    const track = { readyState };
    return { track, value: { getAudioTracks: () => [track] } };
  };

  it("stops repeated speech-service network failures without losing the wake preference", async () => {
    const first = stream();
    openSelectedInputStream.mockResolvedValue(first.value);
    const { instances, cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = instances.at(-1)!;
      rec.onerror?.({ error: "network" });
      rec.onend?.();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(shell.wakeEnabled).toBe(true);
    expect(shell.wakeActive).toBe(false);
    expect(instances).toHaveLength(3);
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Spraakdienst niet bereikbaar" }),
    );
    await vi.advanceTimersByTimeAsync(30000);
    expect(instances).toHaveLength(3);
    setWake(true, "user");
    await vi.advanceTimersByTimeAsync(0);
    expect(instances).toHaveLength(4);
    cleanup();
  });

  it("reopens an ended track when recognition restarts", async () => {
    const first = stream();
    const second = stream();
    openSelectedInputStream
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const { instances, cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    expect(instances[0]!.start).toHaveBeenCalledWith(first.track);
    first.track.readyState = "ended";
    instances[0]!.onend?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(instances[1]!.start).toHaveBeenCalledWith(second.track);
    expect(stopInputStream).toHaveBeenCalledWith(first.value);
    cleanup();
  });

  it("keeps wake enabled through device loss and restarts on reconnect", async () => {
    openSelectedInputStream.mockRejectedValueOnce(
      new DOMException("unplugged", "NotFoundError"),
    );
    const { instances, cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    expect(shell.wakeEnabled).toBe(true);
    expect(shell.wakeActive).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(openSelectedInputStream).toHaveBeenCalledOnce();
    const reconnected = stream();
    openSelectedInputStream.mockResolvedValue(reconnected.value);
    onInputDeviceChange.mock.calls.at(-1)?.[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(instances.at(-1)?.start).toHaveBeenCalledWith(reconnected.track);
    expect(shell.wakeActive).toBe(true);
    cleanup();
  });

  it("preserves wake preference after audio-capture error and releases its stream", async () => {
    const first = stream();
    openSelectedInputStream.mockResolvedValue(first.value);
    const { instances, cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    instances[0]!.onerror?.({ error: "audio-capture" });
    expect(shell.wakeEnabled).toBe(true);
    expect(shell.wakeActive).toBe(false);
    expect(stopInputStream).toHaveBeenCalledWith(first.value);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(openSelectedInputStream).toHaveBeenCalledOnce();
    cleanup();
  });

  it("ignores delayed events from the old recognizer after device reconnect", async () => {
    const first = stream();
    const second = stream();
    openSelectedInputStream
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const { instances, cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    const old = instances[0]!;
    // Real Web Speech stop ends asynchronously, after replacement may start.
    old.stop.mockImplementation(() => {});
    onInputDeviceChange.mock.calls.at(-1)?.[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[1]!.start).toHaveBeenCalledWith(second.track);
    old.onend?.();
    old.onerror?.({ error: "not-allowed" });
    old.onresult?.(result("Hey NOVA doe de lamp aan", true));
    expect(shell.wakeEnabled).toBe(true);
    expect(shell.wakeActive).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openSelectedInputStream).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);
    expect(ask).not.toHaveBeenCalled();
    cleanup();
    instances[1]!.onresult?.(result("Hey NOVA doe de lamp aan", true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ask).not.toHaveBeenCalled();
  });
  it("does not request another stream while the previous start is pending", async () => {
    let resolve: (value: unknown) => void = () => {};
    openSelectedInputStream.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { cleanup } = setup();
    await vi.advanceTimersByTimeAsync(400);
    window.dispatchEvent(new Event("pointerdown"));
    setWake(true);
    expect(openSelectedInputStream).toHaveBeenCalledOnce();
    cleanup();
    const late = stream();
    resolve(late.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopInputStream).toHaveBeenCalledWith(late.value);
  });
});

describe("follow-up after NOVA spoke", () => {
  // Every new phrase gets the next result index, like a running recognizer.
  let index = 100;
  const plain = (text: string, isFinal: boolean): SpeechResultEvent => {
    const results = Array.from({ length: index + 1 }, () => ({
      0: { transcript: "" },
      length: 1,
      isFinal: true,
    }));
    results[index] = { 0: { transcript: text }, length: 1, isFinal };
    const event = { resultIndex: index, results };
    if (isFinal) index++;
    return event;
  };

  it("keeps listening without the wake word for several seconds", () => {
    shell.wakeEnabled = true;
    shell.wakeActive = true;
    noteSpoken("Het is half drie.", true);
    afterSpeech();
    vi.advanceTimersByTime(950);
    expect(shell.awaiting).toBe(true);
    vi.advanceTimersByTime(FOLLOW_UP_MS - 100);
    expect(shell.awaiting).toBe(true);
    handleWakeResult(plain("en morgen", true));
    vi.advanceTimersByTime(650);
    expect(ask).toHaveBeenCalledWith("en morgen", [], "voice");
  });

  it("waits longer after a question and closes the window when nobody answers", () => {
    shell.wakeEnabled = true;
    shell.wakeActive = true;
    noteSpoken("Zal ik dat voor morgen ook bekijken?", true);
    afterSpeech();
    vi.advanceTimersByTime(950 + FOLLOW_UP_QUESTION_MS - 100);
    expect(shell.awaiting).toBe(true);
    vi.advanceTimersByTime(200);
    expect(shell.awaiting).toBe(false);
  });

  it("does not close the window while the owner is still talking", () => {
    shell.wakeEnabled = true;
    shell.wakeActive = true;
    noteSpoken("Het is half drie.", true);
    afterSpeech();
    vi.advanceTimersByTime(950 + FOLLOW_UP_MS - 500);
    handleWakeResult(plain("en wat moet ik dan", false));
    vi.advanceTimersByTime(1000);
    expect(shell.awaiting).toBe(true);
    handleWakeResult(plain("en wat moet ik dan aantrekken", true));
    vi.advanceTimersByTime(650);
    expect(ask).toHaveBeenCalledWith(
      "en wat moet ik dan aantrekken",
      [],
      "voice",
    );
  });

  it("listens once more by itself after a spoken turn when Hey NOVA is off", () => {
    const listen = vi.fn();
    setFollowUpListener(listen);
    noteSpoken("Leuk! Waar ga je heen?", true);
    afterSpeech();
    vi.advanceTimersByTime(700);
    expect(listen).toHaveBeenCalledWith(FOLLOW_UP_QUESTION_MS);
  });

  it("does not open the microphone after a typed question or during a Gesprek", () => {
    const listen = vi.fn();
    setFollowUpListener(listen);
    noteSpoken("Het is half drie.", false);
    afterSpeech();
    vi.advanceTimersByTime(2000);
    noteSpoken("Het is half drie.", true);
    setFollowUpGuard(() => false);
    afterSpeech();
    vi.advanceTimersByTime(2000);
    expect(listen).not.toHaveBeenCalled();
  });

  it("stops talking when the owner says something of their own", () => {
    speaking.now = true;
    speaking.text =
      "Morgen wordt het zonnig in Utrecht met een graad of achttien.";
    handleWakeResult(plain("zonnig in Utrecht met een", false));
    expect(stopSpeech).not.toHaveBeenCalled();
    handleWakeResult(plain("wacht even en zaterdag dan", false));
    expect(stopSpeech).toHaveBeenCalledOnce();
    expect(shell.awaiting).toBe(true);
    speaking.now = false;
    handleWakeResult(plain("wacht even en zaterdag dan", true));
    vi.advanceTimersByTime(650);
    expect(ask).toHaveBeenCalledWith("wacht even en zaterdag dan", [], "voice");
  });
});
