import { chat } from "#lib/stores/chat.svelte.ts";
import { playback } from "#lib/voice/audio.ts";
import { shell } from "#lib/stores/shell.svelte.ts";

let stageTimer: ReturnType<typeof setTimeout> | undefined;
let stageElement: HTMLElement | null = null;

/** The Stage component registers itself, so the answer is never cleared while the pointer rests on it. */
export function registerStage(element: HTMLElement | null): void {
  stageElement = element;
}

/** What the stage shows: what you said, NOVA's answer (as it streams), and whether more is coming. */
export function showStage(
  you: string,
  reply: string,
  streaming: boolean,
): void {
  chat.you = you ? `“${you}”` : "";
  chat.reply = reply;
  chat.streaming = streaming;
  clearTimeout(stageTimer);
  if (reply && !streaming) scheduleStageClear(reply.length);
}

// A finished answer fades from the screen after a reading time; it stays in the conversation drawer.
function scheduleStageClear(
  length: number,
  wait = Math.min(45000, 9000 + length * 45),
): void {
  stageTimer = setTimeout(() => {
    // Never while NOVA is still talking, thinking, listening or the pointer rests on the answer.
    if (
      playback.current ||
      chat.busy ||
      shell.awaiting ||
      stageElement?.matches(":hover")
    )
      return scheduleStageClear(length, 3000);
    showStage("", "", false);
  }, wait);
}
