import type { ChatRequest, ConfirmResult } from "@nova/contracts";
import { sendJson } from "./client.ts";
import {
  syncStoredVoiceProfile,
  ttsProsodyForMood,
  ttsVoiceForSpeech,
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
  signal?.throwIfAborted();
  await syncStoredVoiceProfile();
  signal?.throwIfAborted();
  const body = JSON.stringify({
    text,
    voice: ttsVoiceForSpeech(language),
    prosody: ttsProsodyForMood(mood),
  });
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });
    if (response.ok) return response.blob();
    await response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    if (
      attempt === 0 &&
      [500, 502, 503, 504].includes(response.status) &&
      !response.headers.has("retry-after")
    )
      continue;
    throw new Error(`TTS failed (${response.status})`);
  }
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
