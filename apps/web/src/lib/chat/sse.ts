/** One Server-Sent Event: `event:` name and the parsed `data:` (null when it was not JSON). */
export interface SseEvent {
  event: string;
  data: Record<string, unknown> | null;
}

/** Read an SSE body and call `onEvent` for every complete event. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
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
      onEvent({ event, data });
    }
  }
}
