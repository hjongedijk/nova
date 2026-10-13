/** One Server-Sent Event: `event:` name and the parsed `data:` (null when it was not JSON). */
export interface SseEvent {
  event: string;
  data: Record<string, unknown> | null;
}

/** Read a chat SSE body; EOF alone never confirms a completed reply. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let reachedEof = false;
  const consume = (block: string) => {
    let event = "message";
    let data: SseEvent["data"] = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) {
        try {
          data = JSON.parse(line.slice(5).trim()) as SseEvent["data"];
        } catch {
          data = null;
        }
      }
    }
    // A malformed terminal event cannot finalize partial tokens.
    if (event === "done" && !data) throw new Error("AI response interrupted");
    onEvent({ event, data });
    if (event === "done") completed = true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        consume(block.replace(/\r\n/g, "\n"));
        if (completed) break;
      }
      if (completed) break;
    }
    if (!completed) {
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer.replace(/\r\n/g, "\n"));
    }
    if (!completed)
      throw new Error("AI response interrupted before completion");
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
