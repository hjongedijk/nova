import { claimAlertSpeech, getAlerts } from "#lib/api/shell.ts";
import { chat } from "#lib/stores/chat.svelte.ts";
import { shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { playback } from "#lib/voice/audio.ts";
import { speak } from "#lib/voice/speaker.ts";
import { addMessage } from "./ask.ts";
import { chatEvents } from "./events.ts";
import { showStage } from "./stage.ts";
import { helper } from "#lib/stores/helper.svelte.ts";
import { canSpeakFeedEvent } from "#lib/voice/helper-cues.ts";

/** NOVA speaks up by itself, but never over a conversation. */
async function announce(
  text: string,
  seq: number,
  speakAllowed = true,
): Promise<void> {
  if (
    !speakAllowed ||
    !shell.voiceAlerts ||
    !canSpeakFeedEvent(
      false,
      chat.busy || chat.uiState !== "ready" || Boolean(playback.current),
      helper.cues,
    )
  )
    return;
  try {
    if (!(await claimAlertSpeech(seq))) return;
  } catch {
    return;
  }
  if (chat.busy || chat.uiState !== "ready" || playback.current) return;
  addMessage("assistant", text);
  showStage("", text, false);
  void speak(text);
}

let cursor: number | null = null;

async function pollAlerts(): Promise<void> {
  if (document.hidden) return;
  try {
    const data = await getAlerts(cursor ?? 0);
    const first = cursor === null;
    cursor = data.latest;
    if (first) return; // what happened before this page opened is history
    for (const event of data.events) {
      showToast({
        severity: event.severity,
        title: event.title,
        detail: event.detail || undefined,
      });
      if (event.kind === "timer")
        void announce(
          event.label === "timer"
            ? "Je timer is afgelopen."
            : `Je timer voor ${event.label} is afgelopen.`,
          event.seq,
          event.speakAllowed !== false,
        );
      else if (event.speakAllowed === true || event.severity !== "info")
        void announce(
          `${event.title}.${event.detail ? ` ${event.detail}` : ""}`,
          event.seq,
          event.speakAllowed !== false,
        );
    }
    if (data.events.some((event) => event.kind === "timer"))
      chatEvents.emit("timer");
  } catch {
    /* try again on the next tick */
  }
}

/** Alerts and timers that arrive on their own: a toast, and NOVA says them aloud. Returns the cleanup. */
export function startAlerts(): () => void {
  void pollAlerts();
  const timer = setInterval(pollAlerts, 4000);
  return () => clearInterval(timer);
}
