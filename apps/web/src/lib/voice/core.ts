import { chat } from "#lib/stores/chat.svelte.ts";
import { shell } from "#lib/stores/shell.svelte.ts";
import { isSpeaking, stopSpeech } from "./speaker.ts";
import { cancelActiveAsk } from "#lib/chat/ask.ts";
import { finishListening, startListening } from "./recognition.ts";
import { cancelAwait, startAwait } from "./wake.ts";

/** A press on the sphere (or the mic button): stop talking, stop waiting, or start listening. */
export function pressCore(): void {
  if (isSpeaking()) {
    stopSpeech();
    if (chat.busy) cancelActiveAsk();
    if (shell.wakeActive) {
      startAwait();
      return;
    }
    startListening();
    return;
  }
  if (shell.awaiting) {
    cancelAwait();
    return;
  }
  if (chat.busy) return;
  if (shell.wakeActive) {
    startAwait();
    return;
  }
  startListening();
}

/** Hold F8 to dictate a phrase without relying on the wake listener. */
export function beginPushToTalk(): void {
  if (isSpeaking()) stopSpeech();
  if (chat.busy) cancelActiveAsk();
  if (shell.awaiting) cancelAwait();
  startListening();
}

export { finishListening };
