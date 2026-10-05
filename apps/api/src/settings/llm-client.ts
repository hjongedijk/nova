/** One message for a plain model call (no tools). */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * A plain model call without tools: used to improve and draft skills. The chat module provides
 * it under LLM_CLIENT; without it those two features report that the model is unavailable.
 */
export interface LlmClient {
  /** The text of the model's answer. Rejects when the model cannot be reached. */
  complete(messages: LlmMessage[]): Promise<string>;
}

export const LLM_CLIENT = Symbol("nova:llm-client");
