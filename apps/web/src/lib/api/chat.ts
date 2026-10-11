import type { ChatRequest, ConfirmResult } from "@nova/contracts";
import { sendJson } from "./client.ts";
import {
  ttsProsodyForMood,
  ttsVoiceForLanguage,
} from "#lib/voice/voice-preference.ts";
import type { AssistantMood } from "#lib/stores/chat.svelte.ts";
import {
  getConversationLanguage,
  type ConversationLanguage,
} from "#lib/chat/session.ts";

/**
 * POST /api/chat-stream. Returns the open response (Server-Sent Events) for lib/chat to read.
 * Raw server errors are translated at the user-facing chat boundary.
 */
export async function openChatStream(
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    // The API answers { error }; show the message, not the JSON around it.
    const raw = await response.text();
    let message = raw;
    try {
      message = (JSON.parse(raw) as { error?: string }).error ?? raw;
    } catch {
      /* not JSON: show it as it is */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("Geen antwoord van de server");
  return response.body;
}

/** POST /api/tts: one piece of text turned into audio. */
export async function fetchSpeech(
  text: string,
  signal?: AbortSignal,
  mood: AssistantMood = "neutral",
  language?: ConversationLanguage,
): Promise<Blob> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      voice: ttsVoiceForLanguage(language),
      prosody: ttsProsodyForMood(mood),
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`TTS failed (${response.status}): ${detail}`);
  }
  return response.blob();
}

/** POST /api/actions/confirm: the buttons on a confirmation card. */
export const confirmAction = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
  always = false,
) =>
  sendJson<ConfirmResult>("POST", "/actions/confirm", {
    sessionId,
    confirmationId,
    approve,
    always,
    responseLanguage: getConversationLanguage(),
  });

/** DELETE /api/memory/:sessionId: forget this conversation on the server. */
export const forgetConversation = (sessionId: string) =>
  sendJson<unknown>("DELETE", `/memory/${encodeURIComponent(sessionId)}`);
