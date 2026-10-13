import { describe, expect, it, vi } from "vitest";
import { readEvents } from "./sse.ts";

const body = (text: string) => new Response(text).body!;
describe("chat stream completion", () => {
  it("rejects partial token EOF", async () => {
    const onEvent = vi.fn();
    const stream = body('event: token\ndata: {"text":"Partial"}\n\n');
    await expect(readEvents(stream, onEvent)).rejects.toThrow("interrupted");
    expect(onEvent).toHaveBeenCalledWith({
      event: "token",
      data: { text: "Partial" },
    });
    expect(stream.locked).toBe(false);
  });
  it.each(["\n", "\r\n"])(
    "accepts split UTF8 frames and final done with %j line endings",
    async (line) => {
      const encoded = new TextEncoder().encode(
        `event: token${line}data: {"text":"Café"}${line}${line}event: done${line}data: {"reply":"Café"}${line}${line}`,
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded)
            controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      });
      const onEvent = vi.fn();
      await readEvents(stream, onEvent);
      expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual([
        "token",
        "done",
      ]);
      expect(onEvent.mock.calls[0]?.[0].data.text).toBe("Café");
      expect(stream.locked).toBe(false);
    },
  );
  it("cancels an open transport after terminal done", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: done\ndata: {"reply":"Complete"}\n\n',
          ),
        );
      },
      cancel,
    });
    await readEvents(stream, vi.fn());
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it("cancels and unlocks after server error callback throws", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: error\ndata: {"error":"interrupted"}\n\n',
          ),
        );
      },
      cancel,
    });
    await expect(
      readEvents(stream, () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it("rejects malformed done", async () => {
    await expect(
      readEvents(body("event: done\ndata: invalid\n\n"), vi.fn()),
    ).rejects.toThrow("interrupted");
  });
});
