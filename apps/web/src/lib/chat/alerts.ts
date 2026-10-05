import { getAlerts } from "#lib/api/shell.ts";
import { chat } from "#lib/stores/chat.svelte.ts";
import { shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { playback } from "#lib/voice/audio.ts";
import { speak } from "#lib/voice/speaker.ts";
import { addMessage } from "./ask.ts";
import { chatEvents } from "./events.ts";
import { showStage } from "./stage.ts";

/** NOVA speaks up by itself, but never over a conversation. */
function announce(text: string): void {
  if (!shell.voiceAlerts || chat.busy || playback.current) return;
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
        announce(
          event.label === "timer"
            ? "Je timer is afgelopen."
            : `Je timer voor ${event.label} is afgelopen.`,
        );
      else if (event.severity !== "info")
        announce(`${event.title}.${event.detail ? ` ${event.detail}` : ""}`);
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
