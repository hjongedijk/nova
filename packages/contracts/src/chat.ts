import type { Risk } from "./tools.js";
import type { ModelRoleId } from "./model-roles.js";

/** POST /api/chat-stream sends Server-Sent Events of these kinds. */
export type ChatEvent =
  | { event: "route"; data: { role: ModelRoleId } }
  | { event: "token"; data: { text: string } }
  | {
      event: "tool_start";
      data: { name: string; step?: number; preview?: ToolPreview };
    }
  | {
      event: "tool_result";
      data: { name: string; ok: boolean; step?: number; preview?: ToolPreview };
    }
  | {
      event: "choices";
      data: { choices: { entityId: string; label: string }[] };
    }
  | { event: "confirmation"; data: PendingConfirmation }
  | { event: "attachment_notice"; data: { message: string } }
  | { event: "error"; data: { message: string } }
  | {
      event: "done";
      data: {
        reply: string;
        role?: ModelRoleId;
        model?: string | null;
        /** Required external evidence was unavailable; the request may be retried. */
        unavailable?: true;
      };
    };

/**
 * What the live activity windows show about one tool step. Sanitized and capped at 2 KB server side:
 * titles, domains, short snippets and states only, never secrets or full page bodies. Optional and additive.
 */
export type ToolPreview =
  | {
      kind: "search";
      query?: string;
      results?: { title: string; domain: string }[];
      total?: number;
    }
  | { kind: "page"; title?: string; domain?: string; snippet?: string }
  | { kind: "screen"; question?: string; text?: string }
  | {
      kind: "terminal";
      host?: string;
      command?: string;
      output?: string;
      exitCode?: number;
    }
  | {
      kind: "data";
      title?: string;
      rows?: { label: string; value: string }[];
    }
  | { kind: "status"; message?: string };

export interface ChatAttachment {
  name: string;
  content: string;
  /** Binary documents and images use base64; omitted for UTF-8 text. */
  encoding?: "base64";
  mimeType?: string;
}

export interface ChatRequest {
  /** Up to five files: 10 MiB each, 20 MiB total. */
  attachments?: ChatAttachment[];
  message: string;
  inputMode?: "text" | "voice";
  /** Client-local quiet-hours state; affects voice brevity only, never routing or tools. */
  quietHours?: boolean;
  /** Bounded, user-selected communication preferences; only used for conversation role. */
  communicationPreferences?: CommunicationPreference[];
  /** Explicit language for this conversation and its spoken responses. */
  responseLanguage?: "nl" | "en";
  /** Optional manual override; embeddings are internal and cannot be selected for chat. */
  modelRole?: Exclude<ModelRoleId, "embedding">;
  sessionId: string;
  /** Answers this pending confirmation ("ja"/"nee") instead of starting a new request. */
  confirmationId?: string;
}

export type CommunicationPreference =
  "concise" | "fewer_jokes" | "more_detail" | "warmer";

export interface PendingConfirmation {
  confirmationId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  risk?: Risk;
  createdAt: number;
  expiresAt: number;
  schemaFingerprint?: string;
  /** False when the action cannot create or reuse an Always permission. */
  allowAlways?: boolean;
}
