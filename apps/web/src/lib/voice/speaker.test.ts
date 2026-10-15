import { afterEach, describe, expect, it, vi } from "vitest";

const { audio, playback, fetchSpeech, setState } = vi.hoisted(() => {
  const element = {
    src: "",
    onended: null as null | (() => void),
    onerror: null as null | (() => void),
    onplaying: null as null | (() => void),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  };
  return {
    audio: element,
    playback: { current: null as HTMLAudioElement | null },
    fetchSpeech: vi.fn(async () => new Blob(["audio"])),
    setState: vi.fn(),
  };
});

vi.mock("#lib/api/chat.ts", () => ({ fetchSpeech }));
vi.mock("#lib/stores/chat.svelte.ts", () => ({ setState }));
vi.mock("#lib/stores/toasts.svelte.ts", () => ({ showToast: vi.fn() }));
vi.mock("#lib/modes/wallpaper.ts", () => ({ quietWallpaper: false }));
vi.mock("#lib/voice/audio.ts", () => ({
  applyVolume: vi.fn(),
  attachAnalyser: vi.fn(async () => undefined),
  playback,
  ttsElement: () => audio as unknown as HTMLAudioElement,
}));
vi.mock("#lib/voice/wake.ts", () => ({
  afterSpeech: vi.fn(),
  noteSpoken: vi.fn(),
}));
vi.mock("#lib/stores/helper.svelte.ts", () => ({ helper: { cues: {} } }));
vi.mock("#lib/voice/helper-cues.ts", () => ({ cueQuiet: () => false }));

import { createSpeaker } from "./speaker.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { afterSpeech } from "./wake.ts";

afterEach(() => {
  vi.clearAllMocks();
  fetchSpeech.mockReset().mockResolvedValue(new Blob(["audio"]));
  vi.restoreAllMocks();
  playback.current = null;
  audio.onended = audio.onerror = audio.onplaying = null;
});

describe("speech start measurement", () => {
  it.each(["nl", "en"] as const)(
    "shows one safe %s notice and stops further synthesis after failure",
    async (language) => {
      const diagnostic = "private-tts.invalid token=fixture-secret";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchSpeech.mockRejectedValue(new Error(diagnostic));
      const firstPlayback = vi.fn();
      const speaker = createSpeaker(language, firstPlayback);
      let finished = false;
      void speaker.done.then(() => {
        finished = true;
      });
      speaker.feed("Een eerste synthetische testzin. ");
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      speaker.feed("Een volgende synthetische testzin. ");
      speaker.finish();
      await speaker.done;
      expect(fetchSpeech).toHaveBeenCalledOnce();
      expect(firstPlayback).not.toHaveBeenCalled();
      expect(afterSpeech).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(showToast).mock.calls)).not.toContain(
        diagnostic,
      );
      expect(vi.mocked(showToast).mock.calls[0]?.[0].title).toBe(
        language === "en"
          ? "Speech is unavailable right now"
          : "Spraak is nu niet beschikbaar",
      );
    },
  );

  it("reports first playback, not first text, and reports only once", async () => {
    const firstPlayback = vi.fn();
    const speaker = createSpeaker("nl", firstPlayback);
    speaker.feed("Ik controleer je agenda. ");

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    expect(firstPlayback).not.toHaveBeenCalled();
    audio.onplaying?.();
    audio.onplaying?.();
    expect(firstPlayback).toHaveBeenCalledOnce();

    audio.onended?.();
    speaker.finish();
    await speaker.done;
  });
});
