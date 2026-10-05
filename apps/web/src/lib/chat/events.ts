/** Small notices the shell gives to other areas (the side panels refresh after an answer or a timer). */
type Name = "turnDone" | "timer";

const listeners: Record<Name, Set<() => void>> = {
  turnDone: new Set(),
  timer: new Set(),
};

export const chatEvents = {
  /** `turnDone`: an answer finished (or failed). `timer`: a timer went off. Returns the unsubscribe function. */
  on(name: Name, listener: () => void): () => void {
    listeners[name].add(listener);
    return () => listeners[name].delete(listener);
  },
  emit(name: Name): void {
    for (const listener of listeners[name]) listener();
  },
};
