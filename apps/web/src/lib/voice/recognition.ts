import { ask, chat, setState } from "#lib/stores/chat.svelte.ts";
import { secureBase, shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { IS_IOS } from "#lib/stores/device.ts";
import { recognizerCtor, type Recognizer } from "./speech-types.ts";

/** Tap-to-talk: one phrase, interim text on the stage, an error toast that says what to do. */
let recognition: Recognizer | null = null;

/** Create the recognizer (once). Returns false in browsers without speech recognition. */
export function initRecognition(): boolean {
  if (recognition) return true;
  const Ctor = recognizerCtor();
  shell.speechSupported = Boolean(Ctor);
  if (!Ctor) return false;
  const rec = new Ctor();
  recognition = rec;
  rec.lang = "nl-NL";
  rec.interimResults = true;
  rec.continuous = false;

  let micTimer: ReturnType<typeof setTimeout> | undefined;
  rec.onstart = () => {
    setState("listening");
    // A microphone that hears nothing must not stay "listening" for ever.
    clearTimeout(micTimer);
    micTimer = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }, 15000);
  };

  rec.onerror = (event) => {
    console.error("Speech recognition:", event.error);
    setState("ready");
    if (["not-allowed", "service-not-allowed"].includes(event.error))
      showToast({
        severity: "warning",
        title: "De microfoon is geblokkeerd",
        detail: window.isSecureContext
          ? "Sta de microfoon toe voor deze pagina in de instellingen van je browser."
          : `Open NOVA via ${secureBase()}; zonder beveiligde verbinding mag de microfoon niet.`,
      });
    else if (event.error === "audio-capture")
      showToast({
        severity: "warning",
        title: "Geen microfoon gevonden",
        detail: "Controleer of een andere app de microfoon gebruikt.",
      });
    else if (event.error === "network")
      showToast({
        severity: "warning",
        title: "Spraakherkenning heeft internet nodig",
        detail:
          "Je browser stuurt je stem naar een online dienst. Controleer je verbinding.",
      });
    else if (event.error === "no-speech")
      showToast({
        severity: "info",
        title: "Ik hoorde niets",
        detail: "Tik op de bol en praat meteen.",
      });
  };

  rec.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const text = (last?.[0]?.transcript ?? "").trim();
    if (!last?.isFinal) {
      // Show what is being heard, so it is clear the microphone works.
      chat.you = `“${text}”`;
      return;
    }
    clearTimeout(micTimer);
    if (!text) return;
    void ask(text, [], "voice");
  };

  rec.onend = () => {
    clearTimeout(micTimer);
    if (chat.uiState === "listening") setState("ready");
  };
  return true;
}

export const hasRecognition = (): boolean => recognition !== null;

/** Start listening for one phrase; the sphere and the mic button do this. */
export function startListening(): void {
  const rec = recognition;
  if (!rec) {
    showToast({
      severity: "warning",
      title: "Spraak werkt niet in deze browser",
      detail: IS_IOS
        ? "Open NOVA in Safari (niet in een andere app) of typ je vraag."
        : "Gebruik Chrome of typ je vraag.",
    });
    return;
  }
  if (!window.isSecureContext) {
    showToast({
      severity: "warning",
      title: "De microfoon vraagt een beveiligde verbinding",
      detail: `Open NOVA via ${secureBase()} en accepteer het certificaat één keer.`,
    });
    return;
  }
  try {
    rec.start();
  } catch {
    // The previous session is still closing: end it and try again a moment later.
    try {
      rec.abort();
    } catch {
      /* nothing to abort */
    }
    setTimeout(() => {
      try {
        rec.start();
      } catch {
        setState("ready");
      }
    }, 350);
  }
}
