import type { Risk } from "./tools.js";

/** POST /api/chat-stream sends Server-Sent Events of these kinds. */
export type ChatEvent =
  | { event: "token"; data: { text: string } }
  | { event: "tool_start"; data: { name: string } }
  | { event: "tool_result"; data: { name: string; ok: boolean } }
  | { event: "confirmation"; data: PendingConfirmation }
  | { event: "error"; data: { message: string } }
  | { event: "done"; data: { reply: string } };

export interface ChatAttachment {
  name: string;
  content: string;
}

export interface ChatRequest {
  /** UTF-8 text files, at most three of 16 KiB each. */
  attachments?: ChatAttachment[];
  message: string;
  sessionId: string;
  /** Answers this pending confirmation ("ja"/"nee") instead of starting a new request. */
  confirmationId?: string;
}

export interface PendingConfirmation {
  confirmationId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  risk?: Risk;
  createdAt: number;
  expiresAt: number;
}
