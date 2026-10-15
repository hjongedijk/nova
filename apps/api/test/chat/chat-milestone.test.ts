import { describe, expect, it, vi } from "vitest";
import { ChatController } from "../../src/chat/chat.controller.js";

function fixture() {
  const completedTurn = vi.fn();
  const run = vi
    .fn()
    .mockResolvedValue({ reply: "Synthetic reply.", model: null, usage: null });
  const chat = new ChatController(
    { run } as never,
    {} as never,
    { add: vi.fn() } as never,
    { configured: true } as never,
    { publish: vi.fn() } as never,
    {
      nodeRedEventToken:
        "synthetic-proactive-token-for-milestone-tests-123456789",
    } as never,
    { completedTurn } as never,
  );
  let close = () => {};
  const response = {
    set: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    once: (_event: string, callback: () => void) => {
      close = callback;
    },
    destroyed: false,
    writableEnded: false,
  };
  return { chat, completedTurn, run, response, close: () => close() };
}

describe("completed chat milestone boundary", () => {
  it.each([false, true])(
    "keeps an unavailable answer without counting it, stream=%s",
    async (stream) => {
      const f = fixture();
      f.run.mockResolvedValue({
        reply: "Ik kon je verzoek nu niet afronden.",
        model: null,
        usage: null,
        unavailable: true,
      });
      const request = {
        sessionId: "milestone-unavailable",
        message: "Wat is het actuele weer?",
      };
      if (stream) {
        await f.chat.stream(request, f.response as never);
        const events = f.response.write.mock.calls
          .map(([text]) => String(text))
          .join("");
        expect(events).toContain('"unavailable":true');
        expect(events).toContain("event: done");
      } else
        expect(await f.chat.chat(request)).toMatchObject({
          unavailable: true,
          reply: "Ik kon je verzoek nu niet afronden.",
        });
      expect(f.completedTurn).not.toHaveBeenCalled();
    },
  );
  it.each(["nl", "en"] as const)(
    "marks unavailable proactive work retryable, language=%s",
    async (responseLanguage) => {
      const f = fixture();
      f.run.mockResolvedValueOnce({
        reply: "Synthetic unavailable reply.",
        model: null,
        usage: null,
        unavailable: true,
      });
      const token =
        "Bearer synthetic-proactive-token-for-milestone-tests-123456789";
      let status: unknown;
      try {
        await f.chat.proactiveAsk(token, {
          message: "Actuele briefing",
          responseLanguage,
        });
      } catch (error) {
        status = (error as { getStatus(): number }).getStatus();
      }
      expect(status).toBe(503);
      expect(
        await f.chat.proactiveAsk(token, {
          message: "Actuele briefing",
          responseLanguage,
        }),
      ).toMatchObject({ reply: "Synthetic reply." });
      expect(f.completedTurn).not.toHaveBeenCalled();
    },
  );

  it("counts one completed JSON turn without passing private conversation fields", async () => {
    const f = fixture();
    await f.chat.chat({
      sessionId: "milestone-json",
      message: "Synthetic private question.",
    });
    expect(f.completedTurn).toHaveBeenCalledExactlyOnceWith();
  });
  it("counts one completed stream without passing private fields", async () => {
    const f = fixture();
    await f.chat.stream(
      { sessionId: "milestone-stream", message: "Synthetic question." },
      f.response as never,
    );
    expect(f.completedTurn).toHaveBeenCalledExactlyOnceWith();
    expect(
      f.response.write.mock.calls.some(([text]) =>
        String(text).includes("event: done"),
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    "does not count failed chat with stream=%s",
    async (stream) => {
      const f = fixture();
      f.run.mockRejectedValue(new Error("synthetic failure"));
      const request = {
        sessionId: "milestone-failed",
        message: "Synthetic question.",
      };
      if (stream) await f.chat.stream(request, f.response as never);
      else await expect(f.chat.chat(request)).rejects.toThrow();
      expect(f.completedTurn).not.toHaveBeenCalled();
    },
  );
  it("does not count a stream closed before completion", async () => {
    const f = fixture();
    f.run.mockImplementation(async () => {
      f.close();
      return { reply: "Discarded", model: null, usage: null };
    });
    await f.chat.stream(
      { sessionId: "milestone-aborted", message: "Synthetic question." },
      f.response as never,
    );
    expect(f.completedTurn).not.toHaveBeenCalled();
  });
  it("excludes proactive background requests", async () => {
    const f = fixture();
    await f.chat.proactiveAsk(
      "Bearer synthetic-proactive-token-for-milestone-tests-123456789",
      {
        message: "Synthetic briefing.",
      },
    );
    expect(f.completedTurn).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "keeps completed replies available after counter storage failure, stream=%s",
    async (stream) => {
      const f = fixture();
      f.completedTurn.mockImplementation(() => {
        throw new Error("synthetic private storage diagnostic");
      });
      const request = {
        sessionId: "milestone-storage",
        message: "Synthetic question.",
      };
      if (stream) {
        await f.chat.stream(request, f.response as never);
        expect(
          f.response.write.mock.calls.map(([text]) => text).join(""),
        ).toContain("Synthetic reply.");
        expect(
          f.response.write.mock.calls.map(([text]) => text).join(""),
        ).not.toContain("private storage");
      } else
        expect(await f.chat.chat(request)).toMatchObject({
          reply: "Synthetic reply.",
        });
    },
  );
});
