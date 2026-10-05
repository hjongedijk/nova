export type ToastSeverity = "info" | "warning" | "critical";

export interface Toast {
  id: number;
  severity: ToastSeverity;
  title: string;
  detail?: string;
}

let next = 0;
const MAX_TOASTS = 4;

/** Messages that appear on their own. Newest on top. */
export const toasts = $state<{ items: Toast[] }>({ items: [] });

/**
 * Information goes away by itself after 12 seconds. Warnings and criticals stay until they are closed:
 * they need attention, and the entity turns red while one is open (see `attentionCount`).
 */
export function showToast(
  toast: { severity: ToastSeverity; title: string; detail?: string },
  ms?: number,
): void {
  const entry: Toast = { id: ++next, ...toast };
  toasts.items.unshift(entry);
  while (toasts.items.length > MAX_TOASTS) toasts.items.pop();
  const after = ms ?? (toast.severity === "info" ? 12000 : undefined);
  if (after !== undefined) setTimeout(() => dismissToast(entry.id), after);
}

export function dismissToast(id: number): void {
  const index = toasts.items.findIndex((item) => item.id === id);
  if (index >= 0) toasts.items.splice(index, 1);
}

/** Open toasts that need attention (not plain information). */
export function attentionCount(): number {
  return toasts.items.filter((item) => item.severity !== "info").length;
}
