import { ask, chat, setState } from "#lib/stores/chat.svelte.ts";
import { cancelActiveAsk } from "#lib/chat/ask.ts";
import { secureBase, shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { IS_IOS } from "#lib/stores/device.ts";
import { recognizerCtor, type Recognizer } from "./speech-types.ts";
import { ttsLocale } from "./voice-preference.ts";
import {
  onInputDeviceChange,
  openSelectedInputStream,
  selectedInputDevice,
  stopInputStream,
} from "./input-device.ts";

/** Tap-to-talk: one phrase, interim text on the stage, an error toast that says what to do. */
let recognition: Recognizer | null = null;
let inputStream: MediaStream | null = null;
let listenAttempt = 0;
let transcriptSettleTimer: ReturnType<typeof setTimeout> | undefined;

function sendVoiceWhenReady(text: string): void {
  const deadline = Date.now() + 10_000;
  const send = () => {
    if (!chat.busy) {
      void ask(text, [], "voice");
      return;
    }
    if (Date.now() < deadline) setTimeout(send, 60);
    else
      showToast({
        severity: "info",
        title: "Ik luisterde, maar was nog bezig",
        detail: "Tik nog eens op de bol en probeer het opnieuw.",
      });
  };
  send();
}

function releaseInput(): void {
  stopInputStream(inputStream);
  inputStream = null;
}

/** Create the recognizer (once). Returns false in browsers without speech recognition. */
export function initRecognition(): boolean {
  if (recognition) return true;
  const Ctor = recognizerCtor();
  shell.speechSupported = Boolean(Ctor);
  if (!Ctor) return false;
  const rec = new Ctor();
  recognition = rec;
  onInputDeviceChange(stopListening);
  rec.lang = ttsLocale();
  rec.interimResults = true;
  rec.continuous = false;

  let micTimer: ReturnType<typeof setTimeout> | undefined;
  rec.onstart = () => {
    if (chat.uiState === "speaking") {
      cancelActiveAsk();
    }
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
    releaseInput();
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
      clearTimeout(transcriptSettleTimer);
      // Show what is being heard, so it is clear the microphone works.
      chat.you = `“${text}”`;
      return;
    }
    clearTimeout(micTimer);
    if (!text) return;
    clearTimeout(transcriptSettleTimer);
    transcriptSettleTimer = setTimeout(() => sendVoiceWhenReady(text), 650);
  };

  rec.onend = () => {
    clearTimeout(micTimer);
    releaseInput();
    if (chat.uiState === "listening") setState("ready");
  };
  return true;
}

export const hasRecognition = (): boolean => recognition !== null;

function startWithSelectedInput(
  rec: Recognizer,
  attempt: number,
  retry = true,
): void {
  void openSelectedInputStream()
    .then((stream) => {
      if (attempt !== listenAttempt) {
        stopInputStream(stream);
        return;
      }
      inputStream = stream;
      try {
        const track = stream?.getAudioTracks()[0];
        if (stream && !track)
          throw new Error("De gekozen microfoon heeft geen actieve audio.");
        rec.start(track);
      } catch {
        releaseInput();
        try {
          rec.abort();
        } catch {
          /* recognition may already have ended */
        }
        if (retry) {
          setTimeout(() => {
            if (attempt === listenAttempt)
              startWithSelectedInput(rec, attempt, false);
          }, 350);
        } else {
          setState("ready");
          showToast({
            severity: "warning",
            title: "Spraakherkenning kon niet starten",
            detail: "Controleer de gekozen microfoon en probeer opnieuw.",
          });
        }
      }
    })
    .catch(() => {
      if (attempt !== listenAttempt) return;
      setState("ready");
      showToast({
        severity: "warning",
        title: "Gekozen microfoon niet beschikbaar",
        detail:
          "Controleer de browsertoestemming of kies een andere microfoon in de helperinstellingen.",
      });
    });
}

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
  const attempt = ++listenAttempt;
  if (selectedInputDevice()) {
    startWithSelectedInput(rec, attempt);
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
      if (attempt !== listenAttempt) return;
      try {
        rec.start();
      } catch {
        setState("ready");
      }
    }, 350);
  }
}

/** Stop the explicit recognizer when the native agent pauses. */
export function stopListening(): void {
  listenAttempt++;
  clearTimeout(transcriptSettleTimer);
  transcriptSettleTimer = undefined;
  recognition?.abort();
  releaseInput();
  if (chat.uiState === "listening") setState("ready");
}

/** Finish a held push-to-talk session and let the browser deliver its final phrase. */
export function finishListening(): void {
  try {
    recognition?.stop();
  } catch {
    /* already stopped */
  }
}
