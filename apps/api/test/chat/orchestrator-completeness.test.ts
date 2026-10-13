import { describe, expect, it, vi } from "vitest";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import { IncompleteModelResponseError } from "../../src/chat/omniroute-client.service.js";

describe("tool-enforced response recovery", () => {
  it("discards a failed reminder's tokens and mood before using the complete fallback", async () => {
    const complete = {
      assistant: { role: "assistant", content: "Complete fallback." },
      model: "fixture",
      usage: null,
      metadata: {},
      mood: "happy",
    };
    const call = vi
      .fn()
      .mockImplementationOnce(async (_messages, options) => {
        options.emit("token", { text: "Complete fallback." });
        options.emit("mood", { mood: "happy" });
        return complete;
      })
      .mockImplementationOnce(async (_messages, options) => {
        options.emit("token", { text: "Failed partial" });
        options.emit("mood", { mood: "concerned" });
        throw new IncompleteModelResponseError("premature_eof");
      });
    const definition = {
      name: "weather",
      function: { name: "weather" },
      enabled: true,
      risk: "READ_ONLY",
    };
    const execute = vi.fn();
    const service = new OrchestratorService(
      { maxToolRounds: 3 } as never,
      { call } as never,
      {
        assertFree: () => ({ ready: true }),
        preferredModelForRole: () => undefined,
      } as never,
      {
        list: () => [definition],
        forModel: () => [definition],
        execute,
      } as never,
      { cancel: vi.fn() } as never,
      { handle: vi.fn().mockResolvedValue(null) } as never,
      {
        build: vi
          .fn()
          .mockResolvedValue([{ role: "user", content: "Check weather." }]),
      } as never,
    );
    const emit = vi.fn();
    const reply = await service.run({
      sessionId: "fallback-test",
      message: "Check weather.",
      stream: true,
      emit,
    });
    expect(reply.reply).toBe("Complete fallback.");
    expect(
      emit.mock.calls
        .filter(([event]) => event === "token")
        .map(([, data]) => data.text)
        .join(""),
    ).toBe(reply.reply);
    expect(emit).toHaveBeenCalledWith("mood", { mood: "happy" });
    expect(emit).not.toHaveBeenCalledWith("mood", { mood: "concerned" });
    expect(execute).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
