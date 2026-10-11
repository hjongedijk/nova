import { showToast } from "#lib/stores/toasts.svelte.ts";
import type { ChatAttachment } from "@nova/contracts";
import { openChatStream } from "#lib/api/chat.ts";
import { chat, provideAsk, setState } from "#lib/stores/chat.svelte.ts";
import { playback } from "#lib/voice/audio.ts";
import { createSpeaker, stopSpeaking } from "#lib/voice/speaker.ts";
import { noteSpoken } from "#lib/voice/wake.ts";
import { helper } from "#lib/stores/helper.svelte.ts";
import { cueQuiet } from "#lib/voice/helper-cues.ts";
import {
  addCard,
  finishCard,
  isConfirmReply,
  openCardIds,
} from "./cards.svelte.ts";
import { chatEvents } from "./events.ts";
import { getSessionId } from "./session.ts";
import { readEvents } from "./sse.ts";
import { showStage } from "./stage.ts";
import { nextToolInterjection } from "./tool-interjection.ts";
import { readCommunicationPreferences } from "./communication-preferences.ts";

// A few words about what NOVA is doing, so a long task never looks stuck.
const TOOL_HINTS: [RegExp, string][] = [
  [/^browser_/, "Op je pc aan het browsen…"],
  [/^windows_/, "Je pc aansturen…"],
  [/^proxmox_/, "Proxmox controleren…"],
  [/^(weather|air|moon|iss)_/, "Opzoeken…"],
  [/^(web|wikipedia|news|market|currency)/, "Op het web zoeken…"],
  [/^(timer|list)_/, "Plannen…"],
  [/^(ha_|home_|media_|sonos_|music_)/, "Het huis raadplegen…"],
  [/^(network|alerts|daily)_/, "Controleren…"],
];
const toolHint = (name: unknown): string =>
  TOOL_HINTS.find(([re]) => re.test(String(name || "")))?.[1] ??
  "Actie uitvoeren…";
let previousToolInterjection = "";
let activeRequest: AbortController | null = null;

/** Abort an in-progress stream when the user explicitly interrupts spoken output. */
export function cancelActiveAsk(): void {
  activeRequest?.abort();
}

/** Add a line to the conversation drawer; returns its index so a streaming answer can grow. */
export function addMessage(role: "user" | "assistant", text = ""): number {
  chat.history.push({ role, text });
  return chat.history.length - 1;
}

/**
 * Send something to NOVA as if it was typed: stream the answer onto the stage, speak it sentence by
 * sentence while it is still being written, and close confirmation cards that a "ja"/"nee" answers.
 */
export async function ask(
  raw: string,
  attachments: ChatAttachment[] = [],
  inputMode: "text" | "voice" = "text",
  modelRole?: "conversation" | "code" | "planning" | "summary" | "vision",
): Promise<boolean> {
  const text =
    raw.trim() ||
    (attachments.length ? "Bekijk de bijgevoegde bestanden." : "");
  if (!text || chat.busy) return false;

  stopSpeaking();
  chat.model = "";
  chat.modelRole = "";
  chat.mood = "neutral";
  chat.choices = [];
  chat.toolResult = "";
  chat.activeTool = "";
  chat.busy = true;

  addMessage(
    "user",
    text +
      (attachments.length
        ? `\n📎 ${attachments.map((file) => file.name).join(", ")}`
        : ""),
  );
  const assistant = addMessage("assistant", "");
  const setAssistant = (value: string) => {
    const line = chat.history[assistant];
    if (line) line.text = value;
  };
  showStage(text, "", true);
  setState("thinking");

  let fullReply = "";
  let speakTokens = true;
  let sent = false;
  // "ja"/"nee" while a card is open answers that card; anything else makes the server drop it.
  const cardsBefore = openCardIds();
  const answering =
    cardsBefore.length && isConfirmReply(text)
      ? (cardsBefore.at(-1) ?? null)
      : null;
  const speaker = createSpeaker();
  let interjectionTimer: ReturnType<typeof setTimeout> | null = null;
  const clearInterjection = () => {
    if (interjectionTimer) clearTimeout(interjectionTimer);
    interjectionTimer = null;
  };
  const t0 = performance.now();
  let gotFirst = false;
  const requestController = new AbortController();
  activeRequest = requestController;

  try {
    const body = await openChatStream(
      {
        message: text,
        attachments,
        inputMode,
        quietHours: inputMode === "voice" && cueQuiet(helper.cues),
        communicationPreferences: readCommunicationPreferences(),
        ...(modelRole ? { modelRole } : {}),
        sessionId: getSessionId(),
        ...(answering ? { confirmationId: answering } : {}),
      },
      requestController.signal,
    );

    await readEvents(body, ({ event, data }) => {
      if (event === "route" && typeof data?.role === "string") {
        chat.modelRole = data.role;
        if (inputMode === "voice" && data.role === "code") speakTokens = false;
      }
      if (event === "attachment_notice" && typeof data?.message === "string") {
        showToast({
          severity: "info",
          title: "Bijlage ingekort",
          detail: data.message,
        });
        const user = chat.history[assistant - 1];
        if (user) user.text += `\n${data.message}`;
      }
      if (event === "choices" && Array.isArray(data?.choices))
        chat.choices = data.choices
          .filter(
            (item): item is { entityId: string; label: string } =>
              !!item &&
              typeof item.entityId === "string" &&
              /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/i.test(item.entityId) &&
              item.entityId.length <= 200 &&
              typeof item.label === "string",
          )
          .slice(0, 10);
      if (event === "confirmation")
        addCard(data as unknown as Parameters<typeof addCard>[0]);
      if (event === "tool_start") {
        clearInterjection();
        setState("executing");
        chat.hint = toolHint(data?.name);
        chat.activeTool = String(data?.name ?? "");
        if (inputMode === "voice")
          interjectionTimer = setTimeout(() => {
            const line = nextToolInterjection(previousToolInterjection);
            previousToolInterjection = line;
            speaker.feed(line);
            interjectionTimer = null;
          }, 1500);
      }
      if (event === "tool_result") {
        clearInterjection();
        setState("thinking");
        chat.hint = "";
        chat.activeTool = "";
        chat.toolResult = `${toolHint(data?.name).replace(/…$/, "")}: ${data?.ok === true ? (data?.verified === true ? "gecontroleerd" : data?.accepted === true ? "aangenomen · nog niet gecontroleerd" : "afgerond · niet gecontroleerd") : "niet gelukt"}${data?.standingApproval === true ? " · altijd toegestaan" : ""}`;
      }
      if (
        event === "mood" &&
        (data?.mood === "happy" ||
          data?.mood === "thoughtful" ||
          data?.mood === "concerned" ||
          data?.mood === "enthusiastic" ||
          data?.mood === "neutral")
      ) {
        chat.mood = data.mood;
        speaker.setMood(data.mood);
      }
      if (event === "done") {
        clearInterjection();
        if (typeof data?.model === "string") chat.model = data.model;
        if (typeof data?.role === "string") chat.modelRole = data.role;
        if (
          data?.mood === "happy" ||
          data?.mood === "thoughtful" ||
          data?.mood === "concerned" ||
          data?.mood === "enthusiastic" ||
          data?.mood === "neutral"
        )
          chat.mood = data.mood;
        if (
          inputMode === "voice" &&
          data?.role === "code" &&
          speakTokens === false &&
          fullReply
        ) {
          const fence = fullReply.indexOf("```");
          const candidate = (
            fence >= 0 ? fullReply.slice(0, fence) : fullReply
          ).trim();
          const summary =
            fence >= 0 ||
            (candidate.length <= 280 && !/[{};<>]/.test(candidate))
              ? candidate
              : "";
          speaker.feed(summary || "De code staat op het scherm.");
        }
      }
      if (event === "token" && typeof data?.text === "string" && data.text) {
        if (!gotFirst) {
          gotFirst = true;
          chat.latency = (performance.now() - t0) / 1000;
        }
        fullReply += data.text;
        if (speakTokens) speaker.feed(data.text);
        setAssistant(fullReply);
        showStage(text, fullReply, true);
      }
      if (event === "error")
        throw new Error(
          String(data?.message || data?.error || "Streaming error"),
        );
    });

    if (!fullReply) {
      fullReply = "Daar kreeg ik geen antwoord op. Probeer het nog eens?";
      speaker.feed(fullReply);
      setAssistant(fullReply);
    }

    clearInterjection();

    showStage(text, fullReply, false);

    for (const id of cardsBefore)
      finishCard(
        id,
        id === answering
          ? fullReply
          : "Niet uitgevoerd: je vroeg ondertussen iets anders.",
      );
    // The voice has been speaking along; wait until it has said the last sentence.
    noteSpoken(fullReply);
    speaker.finish();
    await speaker.done;
    sent = true;
  } catch (error) {
    clearInterjection();
    speaker.cancel();
    if (requestController.signal.aborted) {
      setAssistant(
        fullReply ? `${fullReply}\n\n(onderbroken)` : "(onderbroken)",
      );
      showStage(text, fullReply, false);
      setState("ready");
      return false;
    }
    const message = (error as Error).message;
    console.warn("Chat request failed:", message);
    setAssistant(`Er ging iets mis: ${message}`);
    showStage(text, `Er ging iets mis: ${message}`, false);
    setState("ready");
  } finally {
    if (activeRequest === requestController) activeRequest = null;
    clearInterjection();
    chat.busy = false;
    chatEvents.emit("turnDone");
    if (!playback.current) setState("ready");
  }
  return sent;
}

provideAsk(ask);
