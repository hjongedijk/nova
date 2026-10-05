import { fetchSpeech } from "#lib/api/chat.ts";
import { setState } from "#lib/stores/chat.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { quietWallpaper } from "#lib/modes/wallpaper.ts";
import { applyVolume, attachAnalyser, playback, ttsElement } from "./audio.ts";
import { afterSpeech, noteSpoken } from "./wake.ts";

/** What the voice should say for a piece of the (markdown) answer. */
export const speechText = (text: string): string =>
  String(text || "")
    .trim()
    .replace(/\*\*|`/g, "")
    .replace(/\bNOVA\b/g, "Nova")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "");

export interface Speaker {
  /** Add a piece of the answer as it streams in. */
  feed(delta: string): void;
  /** The answer is complete: say what is left. */
  finish(): void;
  cancel(): void;
  /** Resolves when the last sentence has been said (or the speaker was cancelled). */
  done: Promise<void>;
  /** How far the voice is through everything fed so far (0 to 1), to light up the words as they are said. */
  progress(): number;
}

const NO_SPEAKER: Speaker = {
  feed() {},
  finish() {},
  cancel() {},
  done: Promise.resolve(),
  progress: () => 0,
};

let activeSpeaker: Speaker | null = null;
let stopCurrentSpeech: (() => void) | null = null;

/** NOVA is speaking (or about to): clicking the sphere stops it. */
export const isSpeaking = (): boolean =>
  !!playback.current || activeSpeaker !== null;

/** Stop whatever NOVA is saying. */
export function stopSpeech(): void {
  stopCurrentSpeech?.();
}

/** Cancel the speaker and silence the element, before something new is said. */
export function stopSpeaking(): void {
  activeSpeaker?.cancel();
  if (playback.current) {
    playback.current.pause();
    playback.current.src = "";
    playback.current = null;
  }
}

function soundBlockedToast(): void {
  showToast({
    severity: "warning",
    title: "Tik één keer op het scherm voor geluid",
    detail:
      "Je telefoon staat geluid pas toe na een aanraking. Daarna spreekt NOVA gewoon.",
  });
}

/**
 * Speaks while the answer is still being written: every finished sentence is turned into
 * sound at once, the next one is made ready while the current one plays, and the voice
 * starts after the first sentence instead of after the whole answer.
 */
export function createSpeaker(): Speaker {
  if (quietWallpaper) return NO_SPEAKER;
  const tts = ttsElement();
  const abort = new AbortController();
  const items: { text: string; audio?: Promise<string> }[] = [];
  let buffer = "";
  let fedChars = 0;
  let playedChars = 0;
  let cancelled = false;
  let finished = false;
  let playIndex = 0;
  let wake: (() => void) | null = null;
  let endCurrent: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  const load = (item: { text: string; audio?: Promise<string> }) =>
    (item.audio ??= fetchSpeech(speechText(item.text), abort.signal).then(
      (blob) => URL.createObjectURL(blob),
    ));
  const prefetch = () => {
    for (let i = playIndex; i <= playIndex + 1 && i < items.length; i++) {
      const item = items[i];
      if (item) load(item).catch(() => {});
    }
  };
  const push = (text: string) => {
    if (!speechText(text)) return;
    items.push({ text });
    prefetch();
    nudge();
  };
  const playUrl = (url: string, length: number) =>
    new Promise<void>((resolve) => {
      tts.src = url;
      playback.current = tts;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        tts.onended = tts.onerror = null;
        endCurrent = null;
        playedChars += length;
        resolve();
      };
      endCurrent = end;
      tts.onended = end;
      tts.onerror = end;
      void attachAnalyser(tts).then(() => {
        if (cancelled) return end();
        applyVolume(tts);
        setState("speaking");
        tts.play().catch((error: Error) => {
          if (error?.name === "NotAllowedError") soundBlockedToast();
          end();
        });
      });
    });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    abort.abort();
    try {
      tts.pause();
    } catch {
      /* nothing playing */
    }
    endCurrent?.();
    nudge();
  };
  let self: Speaker | null = null;
  const done = (async () => {
    try {
      while (!cancelled) {
        if (playIndex >= items.length) {
          if (finished) break;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        prefetch();
        const item = items[playIndex];
        if (!item) break;
        let url: string;
        try {
          url = await load(item);
        } catch (error) {
          if (cancelled) break;
          console.error("TTS error:", error);
          playedChars += item.text.length;
          playIndex += 1;
          continue;
        }
        if (cancelled) break;
        await playUrl(url, item.text.length);
        URL.revokeObjectURL(url);
        playIndex += 1;
      }
    } finally {
      for (const item of items)
        item.audio?.then(
          (url) => URL.revokeObjectURL(url),
          () => {},
        );
      playback.current = null;
      if (stopCurrentSpeech === cancel) stopCurrentSpeech = null;
      if (activeSpeaker === self) activeSpeaker = null;
      setState("ready");
      afterSpeech();
    }
  })();
  const sentence = /[.!?…]+["”')\]]*\s+|\n+/g;
  const speaker: Speaker = {
    feed(delta) {
      buffer += delta;
      fedChars += delta.length;
      for (;;) {
        const min = items.length === 0 ? 12 : 30;
        let cut = -1;
        sentence.lastIndex = 0;
        for (let m = sentence.exec(buffer); m; m = sentence.exec(buffer))
          if (m.index + m[0].length >= min) {
            cut = m.index + m[0].length;
            break;
          }
        if (cut < 0) return;
        push(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
      }
    },
    finish() {
      finished = true;
      push(buffer);
      buffer = "";
      nudge();
    },
    cancel,
    done,
    progress() {
      const current = playback.current;
      const length = items[playIndex]?.text.length ?? 0;
      const part =
        current && current.duration > 0
          ? (current.currentTime / current.duration) * length
          : 0;
      return fedChars > 0 ? Math.min(1, (playedChars + part) / fedChars) : 0;
    },
  };
  self = speaker;
  stopCurrentSpeech = cancel;
  activeSpeaker = speaker;
  return speaker;
}

/** Say one piece of text (timers and alerts that arrive on their own). */
export async function speak(text: string): Promise<void> {
  const cleaned = String(text || "").trim();
  if (!cleaned || quietWallpaper) return;
  noteSpoken(cleaned);
  setState("speaking");
  const speaker = createSpeaker();
  speaker.feed(cleaned);
  speaker.finish();
  await speaker.done;
}

/** How far the voice is through the answer (0 to 1), for lighting up the words as they are said. */
export const speechProgress = (): number => activeSpeaker?.progress() ?? 0;
