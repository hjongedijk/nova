/** Pure logic of the hands-free 'Gesprek' session: no DOM, no timers of its own, fully testable. */

export const SILENCE_MS_DEFAULT = 1000;
export const SILENCE_MS_MIN = 700;
export const SILENCE_MS_MAX = 2500;
export const IDLE_MS_DEFAULT = 60_000;
export const HIDDEN_LIMIT_MS = 120_000;
export const MAX_RETRIES = 3;
/** Wait after NOVA's last sound before listening again, so the tail of her voice is not heard. */
export const ECHO_TAIL_MS = 600;

export function clampNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (raw === "" || raw === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// ---- end phrases -------------------------------------------------------------------------------

const END_PHRASES = [
  "stop",
  "tot straks",
  "dat was het",
  "bye",
  "stop met luisteren",
  "stop het gesprek",
  "stop gesprek",
  "tot ziens",
  "goodbye",
  "that is all",
  "that's all",
];
const FILLER = new Set([
  "nova",
  "hey",
  "hé",
  "ok",
  "oke",
  "okay",
  "nou",
  "dan",
]);

function normalize(text: string): string {
  return text
    .toLocaleLowerCase("nl-NL")
    .replace(/['’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

/**
 * True only when the whole utterance is an end phrase (optionally with "nova"/"hey" around it).
 * "stop de muziek" or "wat betekent bye" must NOT end the session.
 */
export function isEndPhrase(text: string): boolean {
  const words = normalize(text)
    .split(" ")
    .filter((word) => word && !FILLER.has(word));
  if (!words.length) return false;
  return END_PHRASES.includes(words.join(" "));
}

// ---- backoff -----------------------------------------------------------------------------------

/** Delay before retry number `attempt` (1-based): 400, 800, 1600 ms. */
export function backoffDelay(attempt: number): number {
  return 400 * 2 ** Math.max(0, Math.min(attempt, MAX_RETRIES) - 1);
}
export const shouldGiveUp = (attempt: number): boolean => attempt > MAX_RETRIES;

/** How a recognition error is treated. `quiet` errors only restart; the idle timer ends the session. */
export type ErrorKind = "quiet" | "retry" | "fatal";
export function classifyRecognitionError(error: string): ErrorKind {
  if (error === "no-speech" || error === "aborted") return "quiet";
  if (["not-allowed", "service-not-allowed"].includes(error)) return "fatal";
  return "retry"; // network, audio-capture, language-not-supported, unknown
}

// ---- idle / hidden / endpoint ------------------------------------------------------------------

export const idleExpired = (
  lastActivity: number,
  now: number,
  limit: number,
): boolean => now - lastActivity >= limit;

export const hiddenTooLong = (
  hiddenSince: number | null,
  now: number,
  limit = HIDDEN_LIMIT_MS,
): boolean => hiddenSince !== null && now - hiddenSince >= limit;

/** Collects what the recognizer hears and says when the user has been silent long enough. */
export class UtteranceEndpoint {
  private text = "";
  private changedAt = 0;
  constructor(private readonly silenceMs: number) {}
  update(text: string, now: number): void {
    const clean = text.trim();
    if (clean && clean !== this.text) {
      this.text = clean;
      this.changedAt = now;
    }
  }
  hasText(): boolean {
    return this.text !== "";
  }
  /** Ready when there is text and it has not changed for `silenceMs`. */
  ready(now: number): boolean {
    return this.text !== "" && now - this.changedAt >= this.silenceMs;
  }
  take(): string {
    const value = this.text;
    this.text = "";
    return value;
  }
  reset(): void {
    this.text = "";
  }
}

// ---- turn state machine ------------------------------------------------------------------------

export type Phase = "off" | "listening" | "thinking" | "speaking" | "ending";
export type TurnEvent =
  "start" | "utterance" | "reply-start" | "reply-done" | "barge-in" | "end";

/** Allowed transitions; an event that does not apply leaves the phase unchanged. */
export function nextPhase(phase: Phase, event: TurnEvent): Phase {
  if (event === "start") return phase === "off" ? "listening" : phase;
  if (phase === "off" || phase === "ending") return phase;
  if (event === "end") return "ending";
  switch (phase) {
    case "listening":
      return event === "utterance" ? "thinking" : phase;
    case "thinking":
      if (event === "reply-start") return "speaking";
      if (event === "reply-done") return "listening";
      return phase;
    case "speaking":
      if (event === "reply-done") return "listening";
      if (event === "barge-in") return "listening";
      return phase;
  }
}

// ---- barge-in ----------------------------------------------------------------------------------

/**
 * Conservative level detector: speech must stay above `threshold` for `frames` consecutive
 * samples, and NOVA's own level is subtracted by raising the bar (echo cancellation does the rest).
 */
export class BargeInDetector {
  private run = 0;
  constructor(
    private readonly threshold = 0.09,
    private readonly frames = 7,
  ) {}
  /** Feed one RMS level (0..1); true when barge-in is detected. */
  push(rms: number): boolean {
    this.run = rms >= this.threshold ? this.run + 1 : 0;
    return this.run >= this.frames;
  }
  reset(): void {
    this.run = 0;
  }
}

export function rmsLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = ((samples[i] ?? 128) - 128) / 128; // byte time-domain data
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

// ---- microphone choice and messages ------------------------------------------------------------

export interface InputDevice {
  deviceId: string;
  label: string;
}

/** Keep the saved device when it is still there, else fall back to the default (empty id). */
export function pickDevice(
  devices: InputDevice[],
  savedId: string,
): { deviceId: string; missing: boolean } {
  if (!savedId) return { deviceId: "", missing: false };
  const found = devices.some((device) => device.deviceId === savedId);
  return found
    ? { deviceId: savedId, missing: false }
    : { deviceId: "", missing: true };
}

/** Labels are empty until the user granted microphone permission. */
export const needsPermissionForLabels = (devices: InputDevice[]): boolean =>
  devices.length > 0 && devices.every((device) => !device.label);

export function micErrorMessage(name: string): string {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "service-not-allowed":
    case "not-allowed":
      return "De microfoon is geblokkeerd. Sta de microfoon toe voor deze pagina in je browser.";
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "Geen microfoon gevonden. Sluit een microfoon aan of kies een andere.";
    case "NotReadableError":
    case "AbortError":
    case "audio-capture":
      return "De microfoon is niet bereikbaar. Misschien gebruikt een andere app hem.";
    default:
      return "De microfoon werkt niet. Controleer de verbinding en probeer opnieuw.";
  }
}
