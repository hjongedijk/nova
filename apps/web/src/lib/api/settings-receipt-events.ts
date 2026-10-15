import type { ActionReceipt } from "../stores/chat.svelte.ts";

let receive: ((receipt: ActionReceipt) => void) | undefined;

/** The interface owns presentation; API clients can also run without a mounted interface. */
export function onSettingsReceipt(
  handler: (receipt: ActionReceipt) => void,
): () => void {
  receive = handler;
  return () => {
    if (receive === handler) receive = undefined;
  };
}

export function publishSettingsReceipt(receipt: ActionReceipt): void {
  receive?.(receipt);
}
