import type { Reply } from "./orchestrator.service.js";

/** What goes on the message bus about a finished turn: sizes and timings, never the text itself. */
export function publishableConversation(
  sessionId: string,
  result: Reply,
  startedAt: number,
): Record<string, unknown> {
  return {
    sessionId,
    responseChars: result.reply.length,
    model: result.model,
    durationMs: Date.now() - startedAt,
  };
}
