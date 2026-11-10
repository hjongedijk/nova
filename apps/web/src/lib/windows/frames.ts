// The last frame of each live window, so a result window can show the final page when it cannot frame the site.
const last = new Map<string, Blob>();

export function rememberFrame(windowId: string, frame: Blob): void {
  last.set(windowId, frame);
  if (last.size > 12) last.delete(last.keys().next().value as string);
}

export function lastFrame(windowId: string): Blob | null {
  return last.get(windowId) ?? null;
}
