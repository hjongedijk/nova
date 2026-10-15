import type {
  ChatAttachment,
  ModelRoleId,
  PendingConfirmation,
} from "@nova/contracts";
import { onSettingsReceipt } from "../api/settings-receipt-events.ts";

/** What the entity is doing; the sphere's colour and motion follow it. */
export type UiState =
  "ready" | "listening" | "thinking" | "executing" | "speaking";
export type AssistantMood =
  "happy" | "thoughtful" | "concerned" | "enthusiastic" | "neutral";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ActionReceipt {
  id: string;
  requested: string;
  performed: string;
  verification: string;
  /** Fixed settings history link; rollback there always asks for confirmation. */
  recoverHref?: string;
  /** Fixed family only; historical recovery always requires explicit selection and confirmation. */
  recovery?: "quick-actions";
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
  model: "",
  modelRole: "",
  mood: "neutral" as AssistantMood,
  choices: [] as { entityId: string; label: string }[],
  toolResult: "",
  activeTool: "",
  /** Confirmation cards waiting for a yes or no (settled cards leave this list). */
  confirmations: [] as PendingConfirmation[],
  history: [] as HistoryMessage[],
  actionReceipts: [] as ActionReceipt[],
  /** Time to the first token of the last answer, in seconds. */
  latency: null as number | null,
  /** Time from sending until the browser starts playing NOVA's first sentence. */
  speechLatency: null as number | null,
});

onSettingsReceipt((receipt) => {
  chat.actionReceipts.unshift(receipt);
  chat.actionReceipts.length = Math.min(chat.actionReceipts.length, 10);
});

/** Change what the entity is doing. Only "executing" keeps a tool hint on the status line. */
export function setState(state: UiState): void {
  chat.uiState = state;
  if (state !== "executing") chat.hint = "";
}

/** Set by the chat layer: send something to NOVA as if it was typed. */
export let ask: (
  text: string,
  attachments?: ChatAttachment[],
  inputMode?: "text" | "voice",
  modelRole?: Exclude<ModelRoleId, "embedding">,
) => Promise<boolean> = async () => false;
export function provideAsk(
  fn: (
    text: string,
    attachments?: ChatAttachment[],
    inputMode?: "text" | "voice",
    modelRole?: Exclude<ModelRoleId, "embedding">,
  ) => Promise<boolean>,
): void {
  ask = fn;
}
