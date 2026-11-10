/*
 * Terminal output outside Svelte's reactivity: chunks are appended here and pushed straight to xterm, so a busy
 * command never re-renders the page. A window that opens late replays what it missed. Bounded per terminal and in
 * number of terminals.
 */
const MAX_BYTES = 512 * 1024;
const MAX_TERMINALS = 24;

type Listener = (chunk: string) => void;
const buffers = new Map<
  string,
  { chunks: string[]; size: number; listeners: Set<Listener> }
>();

function entry(id: string) {
  let found = buffers.get(id);
  if (!found) {
    found = { chunks: [], size: 0, listeners: new Set() };
    buffers.set(id, found);
    while (buffers.size > MAX_TERMINALS) {
      const oldest = [...buffers.entries()].find(([, b]) => !b.listeners.size);
      if (!oldest) break;
      buffers.delete(oldest[0]);
    }
  }
  return found;
}

export function writeTerminal(id: string, chunk: string): void {
  const buffer = entry(id);
  buffer.chunks.push(chunk);
  buffer.size += chunk.length;
  while (buffer.size > MAX_BYTES && buffer.chunks.length > 1)
    buffer.size -= buffer.chunks.shift()!.length;
  for (const listener of buffer.listeners) listener(chunk);
}

/** Replays what is there, then streams new chunks. */
export function watchTerminal(id: string, listener: Listener): () => void {
  const buffer = entry(id);
  for (const chunk of buffer.chunks) listener(chunk);
  buffer.listeners.add(listener);
  return () => buffer.listeners.delete(listener);
}

export function terminalText(id: string): string {
  return buffers.get(id)?.chunks.join("") ?? "";
}
