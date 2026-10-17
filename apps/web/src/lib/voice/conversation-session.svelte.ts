import { ask, chat, setState } from "#lib/stores/chat.svelte.ts";
import { cancelActiveAsk } from "#lib/chat/ask.ts";
import { getConversationLanguage } from "#lib/chat/session.ts";
import { shell } from "#lib/stores/shell.svelte.ts";
import { showToast } from "#lib/stores/toasts.svelte.ts";
import { storage } from "#lib/util/storage.ts";
import { applyVolume, audioContext, ttsElement } from "./audio.ts";
import {
  BargeInDetector,
  ECHO_TAIL_MS,
  HIDDEN_LIMIT_MS,
  IDLE_MS_DEFAULT,
  SILENCE_MS_DEFAULT,
  SILENCE_MS_MAX,
  SILENCE_MS_MIN,
  UtteranceEndpoint,
  backoffDelay,
  classifyRecognitionError,
  clampNumber,
  isEndPhrase,
  micErrorMessage,
  needsPermissionForLabels,
  nextPhase,
  pickDevice,
  rmsLevel,
  shouldGiveUp,
  type InputDevice,
  type Phase,
  type TurnEvent,
} from "./conversation-logic.ts";
import {
  selectedInputDevice,
  setSelectedInputDevice,
  supportsSpeechInputSelection,
} from "./input-device.ts";
import { stopListening } from "./recognition.ts";
import { isSpeechEcho } from "./speech-echo.ts";
import { isSpeaking, stopSpeech } from "./speaker.ts";
import {
  recognizerCtor,
  type Recognizer,
  type SpeechResultEvent,
} from "./speech-types.ts";
import { ttsLocale } from "./voice-preference.ts";
import { cancelAwait } from "./wake.ts";

/** The hands-free 'Gesprek': listen, answer, listen again, until the user stops it. */
export const conversation = $state({
  phase: "off" as Phase,
  /** Last status line for the pill ("Gesprek gestopt: …"); empty when nothing to say. */
  notice: "",
  devices: [] as InputDevice[],
  deviceId: "",
});

const silenceMs = () =>
  clampNumber(
    storage.get("novaConvSilenceMs", ""),
    SILENCE_MS_DEFAULT,
    SILENCE_MS_MIN,
    SILENCE_MS_MAX,
  );
const idleMs = () =>
  clampNumber(
    storage.get("novaConvIdleMs", ""),
    IDLE_MS_DEFAULT,
    10_000,
    600_000,
  );

let run = 0;
let stream: MediaStream | null = null;
let level: { source: MediaStreamAudioSourceNode; timer: number } | null = null;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let bargedIn = false;
let detachListeners: (() => void) | null = null;
let activeFinish: ((value: string | null) => void) | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (id: number) => id === run && conversation.phase !== "off";

function fire(event: TurnEvent): void {
  conversation.phase = nextPhase(conversation.phase, event);
}

async function refreshDevices(): Promise<void> {
  try {
    let list = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    if (needsPermissionForLabels(list) && stream) {
      // Labels stay empty until permission was granted; with a live stream they are filled.
      list = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    }
    conversation.devices = list;
  } catch {
    conversation.devices = [];
  }
}

function audioConstraints(deviceId: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

async function openStream(): Promise<MediaStream> {
  const saved = selectedInputDevice();
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(saved),
    });
  } catch (error) {
    const name = (error as Error)?.name ?? "";
    if (saved && ["NotFoundError", "OverconstrainedError"].includes(name)) {
      conversation.notice =
        "De gekozen microfoon is er niet meer; ik gebruik de standaardmicrofoon.";
      return navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(""),
      });
    }
    throw error;
  }
}

/** The user picked another microphone in the pill: restart the stream on it. */
export async function chooseDevice(deviceId: string): Promise<void> {
  setSelectedInputDevice(deviceId);
  conversation.deviceId = deviceId;
  if (conversation.phase === "off") return;
  try {
    const next = await openStream();
    releaseLevel();
    stream?.getTracks().forEach((t) => t.stop());
    stream = next;
    watchTrack(run);
    startLevel();
  } catch (error) {
    endConversation(micErrorMessage((error as Error)?.name ?? ""));
  }
}

function watchTrack(id: number): void {
  stream?.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (alive(id))
      endConversation("De microfoon is losgekoppeld. Gesprek gestopt.");
  });
}

function releaseLevel(): void {
  if (!level) return;
  clearInterval(level.timer);
  try {
    level.source.disconnect();
  } catch {
    /* already disconnected */
  }
  level = null;
}

async function fadeOutAndStop(): Promise<void> {
  const tts = ttsElement();
  for (const m of [0.6, 0.3, 0.1, 0]) {
    applyVolume(tts, m);
    await sleep(30);
  }
  stopSpeech();
  cancelActiveAsk();
}

/** Barge-in: watch the microphone level (echo cancellation on) while NOVA speaks. */
function startLevel(): void {
  if (!stream) return;
  try {
    const ctx = audioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser); // not to destination: never play the mic back
    const detector = new BargeInDetector();
    const data = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      if (!isSpeaking() || conversation.phase === "off") {
        detector.reset();
        return;
      }
      analyser.getByteTimeDomainData(data);
      if (detector.push(rmsLevel(data)) && !bargedIn) {
        bargedIn = true;
        fire("barge-in");
        void fadeOutAndStop();
      }
    }, 50);
    level = { source, timer };
  } catch {
    /* no level meter: no barge-in, mic stays muted while NOVA speaks */
  }
}

function lastReply(): string {
  for (let i = chat.history.length - 1; i >= 0; i--) {
    const message = chat.history[i];
    if (message?.role === "assistant") return message.text;
  }
  return "";
}

/** One recognised utterance, or null when the session ended. */
function listenTurn(id: number): Promise<string | null> {
  const Ctor = recognizerCtor();
  if (!Ctor) return Promise.resolve(null);
  return new Promise((resolve) => {
    const endpoint = new UtteranceEndpoint(silenceMs());
    let lastActivity = Date.now();
    let retries = 0;
    let nextDelay = 250;
    let rec: Recognizer | null = null;
    let done = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    const detach = (r: Recognizer | null) => {
      if (!r) return;
      r.onresult = r.onend = r.onerror = r.onstart = null;
      try {
        r.abort();
      } catch {
        /* already stopped */
      }
    };
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(restartTimer);
      activeFinish = null;
      detach(rec);
      resolve(value);
    };
    activeFinish = finish;
    const start = () => {
      if (done || !alive(id)) return;
      detach(rec);
      const r = new Ctor();
      rec = r;
      r.lang = ttsLocale(getConversationLanguage());
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.onstart = () => setState("listening");
      r.onresult = (event: SpeechResultEvent) => {
        lastActivity = Date.now();
        retries = 0;
        let text = "";
        for (let i = 0; i < event.results.length; i++)
          text += ` ${event.results[i]?.[0]?.transcript ?? ""}`;
        endpoint.update(text, lastActivity);
        if (text.trim()) chat.you = `“${text.trim()}”`;
      };
      r.onerror = (event) => {
        const kind = classifyRecognitionError(event.error);
        if (kind === "fatal") {
          endConversation(micErrorMessage(event.error));
        } else if (kind === "retry") {
          retries += 1;
          if (shouldGiveUp(retries))
            endConversation(
              event.error === "network"
                ? "Spraakherkenning heeft internet nodig. Gesprek gestopt."
                : "Spraakherkenning werkt niet. Gesprek gestopt.",
            );
          else nextDelay = backoffDelay(retries);
        }
      };
      r.onend = () => {
        if (done) return;
        restartTimer = setTimeout(start, nextDelay);
        nextDelay = 250;
      };
      try {
        const track = stream?.getAudioTracks()[0];
        if (
          track &&
          supportsSpeechInputSelection() &&
          track.readyState === "live"
        )
          r.start(track);
        else r.start();
      } catch {
        try {
          r.start();
        } catch {
          retries += 1;
          if (shouldGiveUp(retries))
            endConversation(
              "Spraakherkenning kon niet starten. Gesprek gestopt.",
            );
          else restartTimer = setTimeout(start, backoffDelay(retries));
        }
      }
    };
    const tick = setInterval(() => {
      if (!alive(id)) return finish(null);
      const now = Date.now();
      if (endpoint.ready(now)) return finish(endpoint.take());
      if (!endpoint.hasText() && now - lastActivity >= idleMs()) {
        endConversation(
          `Gesprek gestopt: ik hoorde ${Math.round(idleMs() / 1000)} seconden niets.`,
        );
        finish(null);
      }
    }, 100);
    start();
  });
}

async function answer(id: number, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (chat.busy && Date.now() < deadline && alive(id)) await sleep(80);
  if (!alive(id) || chat.busy) return;
  fire("utterance");
  bargedIn = false;
  const sent = ask(text, [], "voice");
  await sent.catch(() => false);
  await sleep(400); // the voice starts a moment after the stream ends
  while (alive(id) && !bargedIn && (chat.busy || isSpeaking())) {
    if (isSpeaking() && conversation.phase === "thinking") fire("reply-start");
    await sleep(100);
  }
  if (alive(id) && !bargedIn) {
    fire("reply-done");
    await sleep(ECHO_TAIL_MS);
  } else if (bargedIn) {
    // Let the aborted stream settle so the next turn can be sent.
    const settle = Date.now() + 3000;
    while (chat.busy && Date.now() < settle && alive(id)) await sleep(80);
  }
}

async function loop(id: number): Promise<void> {
  while (alive(id)) {
    if (conversation.phase !== "listening") conversation.phase = "listening";
    setState("listening");
    const heard = await listenTurn(id);
    if (!heard || !alive(id)) break;
    chat.you = `“${heard}”`;
    if (isEndPhrase(heard)) {
      endConversation("Gesprek beëindigd.");
      break;
    }
    // Her own voice picked up by the recognizer: ignore it.
    if (isSpeechEcho(heard, lastReply()) && heard.split(" ").length > 2)
      continue;
    await answer(id, heard);
  }
}

function onVisibility(): void {
  clearTimeout(hiddenTimer);
  if (document.hidden)
    hiddenTimer = setTimeout(
      () =>
        endConversation(
          "Gesprek gestopt omdat dit tabblad lang verborgen was.",
        ),
      HIDDEN_LIMIT_MS,
    );
}

/** Start the session. Call only from a user gesture (click). */
export async function startConversation(): Promise<boolean> {
  if (conversation.phase !== "off") return true;
  conversation.notice = "";
  if (!recognizerCtor()) {
    conversation.notice =
      "Spraak werkt niet in deze browser. Gebruik Chrome of typ je vraag.";
    return false;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    conversation.notice = "De microfoon vraagt een beveiligde verbinding.";
    return false;
  }
  if (shell.wakeActive) {
    showToast({
      severity: "info",
      title: "Zet ‘Hey NOVA’ eerst uit",
      detail:
        "Een gesprek en de wake-word-luisteraar kunnen niet tegelijk naar je microfoon luisteren.",
    });
    return false;
  }
  const id = ++run;
  conversation.phase = "listening"; // claim before the permission prompt resolves
  try {
    stopListening();
    cancelAwait();
    stream = await openStream();
    if (id !== run) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
  } catch (error) {
    conversation.phase = "off";
    conversation.notice = micErrorMessage((error as Error)?.name ?? "");
    return false;
  }
  await refreshDevices();
  const picked = pickDevice(conversation.devices, selectedInputDevice());
  conversation.deviceId = picked.deviceId;
  watchTrack(id);
  startLevel();
  const onDevices = () => void refreshDevices();
  navigator.mediaDevices.addEventListener("devicechange", onDevices);
  document.addEventListener("visibilitychange", onVisibility);
  detachListeners = () => {
    navigator.mediaDevices.removeEventListener("devicechange", onDevices);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  void loop(id);
  return true;
}

/** Stop the session; `notice` is shown in the pill (nothing is spoken). */
export function endConversation(notice = "Gesprek gestopt."): void {
  if (conversation.phase === "off") return;
  run++;
  conversation.phase = "off";
  conversation.notice = notice;
  clearTimeout(hiddenTimer);
  detachListeners?.();
  detachListeners = null;
  activeFinish?.(null);
  releaseLevel();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  bargedIn = false;
  if (chat.uiState === "listening") setState("ready");
  chat.you = "";
}

/** The pill's stop button: also silence NOVA and drop the running request. */
export function stopConversation(): void {
  stopSpeech();
  cancelActiveAsk();
  endConversation("Gesprek gestopt.");
}
