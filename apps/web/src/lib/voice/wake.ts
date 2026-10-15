import { ask, chat, setState } from "#lib/stores/chat.svelte.ts";
import { showChrome } from "#lib/stores/chrome.svelte.ts";
import { IS_MOBILE } from "#lib/stores/device.ts";
import { secureBase, shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { storage } from "#lib/util/storage.ts";
import { quietWallpaper } from "#lib/modes/wallpaper.ts";
import { playback } from "./audio.ts";
import { isSpeaking, stopSpeech } from "./speaker.ts";
import { isSpeechEcho } from "./speech-echo.ts";
import { cancelActiveAsk } from "#lib/chat/ask.ts";
import { chime } from "./chime.ts";
import { findWake } from "./wake-matcher.ts";
export { findWake, WAKE_LOOSE, WAKE_STRICT } from "./wake-matcher.ts";
import {
  recognizerCtor,
  type Recognizer,
  type RecognizerCtor,
  type SpeechResult,
  type SpeechResultEvent,
} from "./speech-types.ts";
import {
  onInputDeviceChange,
  openSelectedInputStream,
  selectedInputDevice,
  stopInputStream,
} from "./input-device.ts";

/* ==========================================================
 * "Hey NOVA": the microphone listens along, and a chime says it heard you
 * ========================================================== */

/** What was said after the wake word, or the whole text when there is none. */
export function afterWake(text: string): string {
  const found = findWake(text);
  return (found ? text.slice(found.end) : text)
    .replace(/^[\s,.!?:;-]+/, "")
    .trim();
}

let Ctor: RecognizerCtor | null = null;
let wakeRec: Recognizer | null = null;
let awaitIndex = 0;
let awaitTimer: ReturnType<typeof setTimeout> | undefined;
let lastLength = 0;
let ignoreUntil = 0;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;
let quickEnds = 0;
let insecureWarned = false;
let wakeInputStream: MediaStream | null = null;
let wakeInputDevice = "";
let wakeStartAttempt = 0;
let wakeStarting = false;

/** The wake word handler needs to know NOVA is not busy answering. */
const busyTalking = () =>
  chat.busy ||
  !!playback.current ||
  chat.uiState === "speaking" ||
  Date.now() < ignoreUntil;

function finishAwait(): void {
  shell.awaiting = false;
  clearTimeout(awaitTimer);
  clearTimeout(settleTimer);
  pendingFinalIndex = -1;
  if (chat.uiState === "listening") setState("ready");
  chat.you = "";
}

function beginAwait({
  withChime = true,
  ms = 9000,
  index = lastLength,
}: { withChime?: boolean; ms?: number; index?: number } = {}): void {
  shell.awaiting = true;
  awaitIndex = index;
  setState("listening");
  chat.hint = "Ik luister…";
  showChrome();
  if (withChime) chime();
  clearTimeout(awaitTimer);
  awaitTimer = setTimeout(finishAwait, ms);
}

/** Stop waiting for a command (a click on the sphere while NOVA waits). */
export const cancelAwait = finishAwait;
/** Wait for a command right now (a click on the sphere while "Hey NOVA" listens). */
export const startAwait = beginAwait;

// The recognizer gives a few guesses per phrase; the one with the wake word wins.
function bestHeard(result: SpeechResult): string {
  const guesses: string[] = [];
  for (let k = 0; k < (result.length ?? 1); k++) {
    const text = String(result[k]?.transcript || "").trim();
    if (text) guesses.push(text);
  }
  return guesses.find((text) => findWake(text)) ?? guesses[0] ?? "";
}

// The recognizer only calls a phrase final after a pause. When the words have stopped changing
// for a moment, NOVA already has what it needs and answers without waiting for that.
const SETTLED_MS = 1100;
const FINAL_SETTLED_MS = 650;
let sentIndex = -1;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFinalIndex = -1;
function sendCommand(command: string, index: number): void {
  sentIndex = index;
  clearTimeout(settleTimer);
  finishAwait();
  shell.draft = "";
  const deadline = Date.now() + 10_000;
  const send = () => {
    if (!chat.busy) {
      void ask(command, [], "voice");
      return;
    }
    if (Date.now() < deadline) setTimeout(send, 60);
    else
      showToast({
        severity: "info",
        title: "Ik luisterde, maar was nog bezig",
        detail: "Zeg Hey NOVA nog eens en probeer het opnieuw.",
      });
  };
  send();
}
function sendWhenSettled(command: string, index: number): void {
  clearTimeout(settleTimer);
  pendingFinalIndex = -1;
  if (command.length < 3) return;
  settleTimer = setTimeout(() => {
    if (!busyTalking() && index > sentIndex) sendCommand(command, index);
  }, SETTLED_MS);
}

function sendFinalWhenSettled(command: string, index: number): void {
  clearTimeout(settleTimer);
  pendingFinalIndex = index;
  settleTimer = setTimeout(() => {
    pendingFinalIndex = -1;
    if (index > sentIndex) sendCommand(command, index);
  }, FINAL_SETTLED_MS);
}

export function handleWakeResult(event: SpeechResultEvent): void {
  lastLength = event.results.length;
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (!result) continue;
    const heard = bestHeard(result);
    if (!result.isFinal && i >= pendingFinalIndex && pendingFinalIndex >= 0) {
      clearTimeout(settleTimer);
      pendingFinalIndex = -1;
    }
    if (isSpeaking() && findWake(heard) && !isSpeechEcho(heard, lastSpoken)) {
      stopSpeech();
      if (chat.busy) cancelActiveAsk();
      if (!shell.awaiting) beginAwait({ withChime: false, index: i });
    }
    if (busyTalking() && !shell.awaiting) continue; // never answer our own voice
    if (i <= sentIndex) continue; // this phrase was already answered
    if (!heard) continue;
    if (shell.awaiting) {
      if (i < awaitIndex) continue;
      const command = afterWake(heard);
      if (!result.isFinal) {
        if (command) chat.you = `“${command}…”`;
        sendWhenSettled(command, i);
        continue;
      }
      if (command.length >= 2) sendFinalWhenSettled(command, i);
      else if (i === awaitIndex) {
        awaitIndex = i + 1; // only the wake word so far: the command is still to come
      }
      continue;
    }
    if (!findWake(heard)) continue;
    const command = afterWake(heard);
    if (result.isFinal && command.length >= 2) sendFinalWhenSettled(command, i);
    else {
      beginAwait({ index: result.isFinal ? i + 1 : i });
      sendWhenSettled(command, i);
    }
  }
}

// A short, silent follow-up window makes voice chat feel continuous without leaving the
// explicit wake listener in command mode all day.
let lastSpoken = "";
const askedSomething = (text: string) => /\?/.test(String(text).slice(-160));

/** Remember what NOVA said last, so afterSpeech knows whether it asked a question. */
export function noteSpoken(text: string): void {
  lastSpoken = text;
}

/** Called when NOVA stops talking. */
export function afterSpeech(): void {
  ignoreUntil = Date.now() + 900;
  if (shell.wakeEnabled && shell.wakeActive)
    setTimeout(() => {
      if (!chat.busy && !playback.current && !shell.awaiting)
        beginAwait({
          withChime: false,
          ms: askedSomething(lastSpoken) ? 6000 : 4000,
        });
    }, 950);
}

function stopWake(): void {
  wakeStartAttempt++;
  wakeStarting = false;
  clearTimeout(restartTimer);
  clearTimeout(settleTimer);
  pendingFinalIndex = -1;
  sentIndex = -1;
  const rec = wakeRec;
  wakeRec = null;
  shell.wakeActive = false;
  try {
    rec?.stop();
  } catch {
    /* already stopped */
  }
  stopInputStream(wakeInputStream);
  wakeInputStream = null;
  wakeInputDevice = "";
}

async function startWake(): Promise<void> {
  if (!Ctor || !shell.wakeEnabled || wakeRec || wakeStarting) return;
  if (!window.isSecureContext) {
    if (!insecureWarned) {
      insecureWarned = true;
      showToast({
        severity: "warning",
        title: "De microfoon vraagt een beveiligde verbinding",
        detail: `Open NOVA via ${secureBase()} om “Hey NOVA” te gebruiken.`,
      });
    }
    return;
  }
  const attempt = ++wakeStartAttempt;
  wakeStarting = true;
  const rec = new Ctor();
  rec.lang = "nl-NL";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  rec.onstart = () => {
    if (attempt !== wakeStartAttempt) return;
    sentIndex = -1;
    shell.wakeActive = true;
    startedAt = Date.now();
    lastLength = 0;
  };
  rec.onresult = (event) => {
    if (attempt !== wakeStartAttempt || !shell.wakeEnabled) return;
    handleWakeResult(event);
  };
  rec.onerror = (error) => {
    if (attempt !== wakeStartAttempt) return;
    if (
      error.error === "not-allowed" ||
      error.error === "service-not-allowed"
    ) {
      shell.wakeEnabled = false;
      storage.set("novaWake", "off");
      stopWake();
      showToast({
        severity: "warning",
        title: "De microfoon is geblokkeerd",
        detail:
          "Sta de microfoon toe voor deze pagina en zet Hey NOVA daarna weer aan in het menu.",
      });
    } else if (error.error === "audio-capture") {
      showToast({
        severity: "warning",
        title: "Geen microfoon gevonden",
        detail: "Sluit een microfoon aan.",
      });
      // Device loss is temporary. Preserve the user's wake preference and wait
      // for devicechange instead of polling or switching microphones silently.
      stopWake();
    }
  };
  rec.onend = () => {
    if (attempt !== wakeStartAttempt) return;
    shell.wakeActive = false;
    wakeRec = null;
    if (!shell.wakeEnabled || attempt !== wakeStartAttempt) return;
    // The browser ends continuous recognition now and then. Start again,
    // and back off when it keeps ending immediately (microphone busy).
    quickEnds = Date.now() - startedAt < 1500 ? quickEnds + 1 : 0;
    restartTimer = setTimeout(startWake, Math.min(5000, 250 * 2 ** quickEnds));
  };
  try {
    const input = selectedInputDevice();
    const cachedTrack = wakeInputStream?.getAudioTracks()[0];
    if (
      wakeInputStream &&
      (input !== wakeInputDevice || cachedTrack?.readyState !== "live")
    ) {
      stopInputStream(wakeInputStream);
      wakeInputStream = null;
      wakeInputDevice = "";
    }
    if (input && !wakeInputStream) {
      const stream = await openSelectedInputStream();
      if (attempt !== wakeStartAttempt || !shell.wakeEnabled) {
        stopInputStream(stream);
        return;
      }
      wakeInputStream = stream;
      wakeInputDevice = input;
    }
    if (attempt !== wakeStartAttempt || !shell.wakeEnabled) return;
    const track = wakeInputStream?.getAudioTracks()[0];
    if (wakeInputStream && !track)
      throw new Error("The selected microphone has no audio track");
    wakeRec = rec;
    rec.start(track);
  } catch {
    if (attempt !== wakeStartAttempt) return;
    wakeRec = null;
    stopInputStream(wakeInputStream);
    wakeInputStream = null;
    wakeInputDevice = "";
    showToast({
      severity: "warning",
      title: "Gekozen microfoon niet beschikbaar",
      detail:
        "Je keuze blijft bewaard. Sluit de microfoon opnieuw aan of controleer de browsertoestemming in de helperinstellingen.",
    });
  } finally {
    if (attempt === wakeStartAttempt) wakeStarting = false;
  }
}

/** Switch "Hey NOVA" on or off (the menu toggle); remembered in this browser. */
export function setWake(
  on: boolean,
  origin: "user" | "system" = "system",
): void {
  shell.wakeEnabled = on && !!Ctor;
  storage.set(
    "novaWake",
    shell.wakeEnabled ? "on" : "off",
    origin === "user" ? "wake" : undefined,
  );
  if (shell.wakeEnabled) startWake();
  else stopWake();
}

/** Read the saved choice and start listening. Returns the cleanup. */
export function initWake(): () => void {
  Ctor = recognizerCtor();
  shell.wakeEnabled =
    !!Ctor &&
    !quietWallpaper &&
    storage.get("novaWake", IS_MOBILE ? "off" : "on") !== "off";
  // Some browsers only start the microphone after a first touch of the page.
  const onFirstTouch = () => {
    if (shell.wakeEnabled && !wakeRec) startWake();
  };
  window.addEventListener("pointerdown", onFirstTouch, { once: true });
  (window as unknown as { __wake?: unknown }).__wake = {
    find: findWake,
    after: afterWake,
    handle: handleWakeResult,
  };
  const timer = setTimeout(startWake, 400);
  const removeInputListener = onInputDeviceChange(() => {
    const wasEnabled = shell.wakeEnabled;
    stopWake();
    if (wasEnabled) void startWake();
  });
  return () => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", onFirstTouch);
    removeInputListener();
    clearTimeout(settleTimer);
    clearTimeout(awaitTimer);
    stopWake();
  };
}
