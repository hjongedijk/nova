import type { PendingConfirmation } from "@nova/contracts";

/** What the entity is doing; the sphere's colour and motion follow it. */
export type UiState =
  "ready" | "listening" | "thinking" | "executing" | "speaking";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** The conversation as the screen shows it. The chat layer (lib/chat) is the only writer. */
export const chat = $state({
  uiState: "ready" as UiState,
  busy: false,
  /** What the user just said / what NOVA is saying; cleared again after a reading time. Includes the quotes. */
  you: "",
  reply: "",
  streaming: false,
  /** A few words about what NOVA is doing ("Proxmox controleren…"); empty shows the idle hint. */
  hint: "",
  /** Confirmation cards waiting for a yes or no (settled cards leave this list). */
  confirmations: [] as PendingConfirmation[],
  history: [] as HistoryMessage[],
  /** Time to the first token of the last answer, in seconds. */
  latency: null as number | null,
});

/** Change what the entity is doing. Only "executing" keeps a tool hint on the status line. */
export function setState(state: UiState): void {
  chat.uiState = state;
  if (state !== "executing") chat.hint = "";
}

/** Set by the chat layer: send something to NOVA as if it was typed. */
export let ask: (text: string) => Promise<void> = async () => {};
export function provideAsk(fn: (text: string) => Promise<void>): void {
  ask = fn;
}
