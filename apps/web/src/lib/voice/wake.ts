import { ask, chat, setState } from "#lib/stores/chat.svelte.ts";
import { showChrome } from "#lib/stores/chrome.svelte.ts";
import { IS_MOBILE } from "#lib/stores/device.ts";
import { secureBase, shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { storage } from "#lib/util/storage.ts";
import { quietWallpaper } from "#lib/modes/wallpaper.ts";
import { playback } from "./audio.ts";
import { chime } from "./chime.ts";
import {
  recognizerCtor,
  type Recognizer,
  type RecognizerCtor,
  type SpeechResult,
  type SpeechResultEvent,
} from "./speech-types.ts";

/* ==========================================================
 * "Hey NOVA": the microphone listens along, and a chime says it heard you
 * ========================================================== */

export const WAKE_STRICT =
  /\b(?:nova|novah|novaa|nofa|nofah|noba|nowa|noova|nuva|no[\s-]va)\b/i;
export const WAKE_LOOSE =
  /\b(?:hey|hé|hee|he|hoi|hallo|ok|oké|okay|hi)[\s,.!?-]+(?:no[\s-]?[vbfw]a+h?|noah|nover|noe[\s-]?va|nu[\s-]?va)\b/i;

export function findWake(text: string): { start: number; end: number } | null {
  const match = WAKE_STRICT.exec(text) || WAKE_LOOSE.exec(text);
  return match
    ? { start: match.index, end: match.index + match[0].length }
    : null;
}

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
let sentIndex = -1;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
function sendCommand(command: string, index: number): void {
  sentIndex = index;
  clearTimeout(settleTimer);
  finishAwait();
  shell.draft = "";
  void ask(command);
}
function sendWhenSettled(command: string, index: number): void {
  clearTimeout(settleTimer);
  if (command.length < 3) return;
  settleTimer = setTimeout(() => {
    if (!busyTalking() && index > sentIndex) sendCommand(command, index);
  }, SETTLED_MS);
}

export function handleWakeResult(event: SpeechResultEvent): void {
  lastLength = event.results.length;
  for (let i = event.resultIndex; i < event.results.length; i++) {
    if (busyTalking()) continue; // never answer our own voice
    if (i <= sentIndex) continue; // this phrase was already answered
    const result = event.results[i];
    if (!result) continue;
    const heard = bestHeard(result);
    if (!heard) continue;
    if (shell.awaiting) {
      if (i < awaitIndex) continue;
      const command = afterWake(heard);
      if (!result.isFinal) {
        if (command) chat.you = `“${command}…”`;
        sendWhenSettled(command, i);
        continue;
      }
      if (command.length >= 2) sendCommand(command, i);
      else if (i === awaitIndex) {
        awaitIndex = i + 1; // only the wake word so far: the command is still to come
      }
      continue;
    }
    if (!findWake(heard)) continue;
    const command = afterWake(heard);
    if (result.isFinal && command.length >= 2) sendCommand(command, i);
    else {
      beginAwait({ index: result.isFinal ? i + 1 : i });
      sendWhenSettled(command, i);
    }
  }
}

// NOVA only keeps listening after it spoke when it asked something ("Zal ik ...?", "Welke bedoel je?").
// After a plain answer the microphone stays closed until "Hey NOVA" or a click on the sphere.
let lastSpoken = "";
const askedSomething = (text: string) => /\?/.test(String(text).slice(-160));

/** Remember what NOVA said last, so afterSpeech knows whether it asked a question. */
export function noteSpoken(text: string): void {
  lastSpoken = text;
}

/** Called when NOVA stops talking. */
export function afterSpeech(): void {
  ignoreUntil = Date.now() + 900;
  if (shell.wakeEnabled && shell.wakeActive && askedSomething(lastSpoken))
    setTimeout(() => {
      if (!chat.busy && !playback.current && !shell.awaiting)
        beginAwait({ withChime: false, ms: 6000 });
    }, 950);
}

function stopWake(): void {
  clearTimeout(restartTimer);
  const rec = wakeRec;
  wakeRec = null;
  shell.wakeActive = false;
  try {
    rec?.stop();
  } catch {
    /* already stopped */
  }
}

function startWake(): void {
  if (!Ctor || !shell.wakeEnabled || wakeRec) return;
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
  const rec = new Ctor();
  rec.lang = "nl-NL";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  rec.onstart = () => {
    sentIndex = -1;
    shell.wakeActive = true;
    startedAt = Date.now();
    lastLength = 0;
  };
  rec.onresult = handleWakeResult;
  rec.onerror = (error) => {
    if (
      error.error === "not-allowed" ||
      error.error === "service-not-allowed"
    ) {
      shell.wakeEnabled = false;
      storage.set("jarvisWake", "off");
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
    }
  };
  rec.onend = () => {
    shell.wakeActive = false;
    wakeRec = null;
    if (!shell.wakeEnabled) return;
    // The browser ends continuous recognition now and then. Start again,
    // and back off when it keeps ending immediately (microphone busy).
    quickEnds = Date.now() - startedAt < 1500 ? quickEnds + 1 : 0;
    restartTimer = setTimeout(startWake, Math.min(5000, 250 * 2 ** quickEnds));
  };
  wakeRec = rec;
  try {
    rec.start();
  } catch {
    wakeRec = null;
  }
}

/** Switch "Hey NOVA" on or off (the menu toggle); remembered in this browser. */
export function setWake(on: boolean): void {
  shell.wakeEnabled = on && !!Ctor;
  storage.set("jarvisWake", shell.wakeEnabled ? "on" : "off");
  if (shell.wakeEnabled) startWake();
  else stopWake();
}

/** Read the saved choice and start listening. Returns the cleanup. */
export function initWake(): () => void {
  Ctor = recognizerCtor();
  shell.wakeEnabled =
    !!Ctor &&
    !quietWallpaper &&
    storage.get("jarvisWake", IS_MOBILE ? "off" : "on") !== "off";
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
  return () => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", onFirstTouch);
    clearTimeout(settleTimer);
    clearTimeout(awaitTimer);
    stopWake();
  };
}
