import { audioContext, ttsElement } from "./audio.ts";

const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

let unlocked = false;

/** The first touch (or key) unlocks the shared audio element and the audio context. */
function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  const element = ttsElement();
  try {
    element.src = SILENCE;
    const started = element.play();
    if (started?.then)
      started
        .then(() => element.src === SILENCE && element.pause())
        .catch(() => (unlocked = false));
    void audioContext().resume();
  } catch {
    unlocked = false;
  }
}

/** Phones only allow sound after a touch. Returns the function that removes the listeners. */
export function installAudioUnlock(): () => void {
  const types = ["pointerdown", "touchend", "keydown"] as const;
  for (const type of types)
    window.addEventListener(type, unlockAudio, { passive: true });
  return () => {
    for (const type of types) window.removeEventListener(type, unlockAudio);
  };
}
