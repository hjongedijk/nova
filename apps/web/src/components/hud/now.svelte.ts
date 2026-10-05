/** The current time as a rune, ticking once a second while something reads it. */
import { createSubscriber } from "svelte/reactivity";

const subscribe = createSubscriber((update) => {
  const timer = setInterval(update, 1000);
  return () => clearInterval(timer);
});

export const now = {
  get ms(): number {
    subscribe();
    return Date.now();
  },
};
