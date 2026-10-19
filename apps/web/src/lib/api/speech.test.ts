import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSpeech } from "./chat.ts";

vi.mock("#lib/voice/voice-preference.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncStoredVoiceProfile: vi.fn(async () => ({ status: "unchanged" })),
}));

afterEach(() => vi.unstubAllGlobals());

describe("speech transport", () => {
  it("does not retry if cancelled while releasing a failed response", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array([1]));
        },
        cancel() {
          controller.abort();
        },
      }),
      { status: 500 },
    );
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);
    await expect(
      fetchSpeech(
        "Een synthetische testzin.",
        controller.signal,
        "neutral",
        "nl",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries one temporary TTS failure with the same request and releases its body", async () => {
    const failed = new Response("private diagnostic", { status: 500 });
    const request = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(
        new Response("audio", { headers: { "content-type": "audio/mpeg" } }),
      );
    vi.stubGlobal("fetch", request);
    const audio = await fetchSpeech(
      "Een synthetische testzin.",
      undefined,
      "neutral",
      "nl",
    );
    expect(await audio.text()).toBe("audio");
    expect(failed.bodyUsed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });

  it("stops after the second failure without retaining response diagnostics", async () => {
    const request = vi
      .fn()
      .mockImplementation(
        async () => new Response("private diagnostic", { status: 500 }),
      );
    vi.stubGlobal("fetch", request);
    await expect(
      fetchSpeech("Een synthetische testzin.", undefined, "neutral", "nl"),
    ).rejects.toThrow(/^TTS failed \(500\)$/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a server retry-after instruction", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response("private diagnostic", {
        status: 503,
        headers: { "retry-after": "60" },
      }),
    );
    vi.stubGlobal("fetch", request);
    await expect(
      fetchSpeech("Een synthetische testzin.", undefined, "neutral", "nl"),
    ).rejects.toThrow(/^TTS failed \(503\)$/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("discards failed response diagnostics and releases the response body", async () => {
    const diagnostic = "private-tts.invalid /srv/private token=fixture-secret";
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(diagnostic));
          controller.close();
        },
        cancel: cancelled,
      }),
      { status: 403 },
    );
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);
    await expect(
      fetchSpeech("Een synthetische testzin.", undefined, "neutral", "nl"),
    ).rejects.toThrow(/^TTS failed \(403\)$/);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps successful audio bytes and media type", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          headers: { "content-type": "audio/wav" },
        }),
      ),
    );
    const blob = await fetchSpeech(
      "Een synthetische testzin.",
      undefined,
      "neutral",
      "nl",
    );
    expect(blob.type).toBe("audio/wav");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("preserves cancellation without retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new DOMException("The operation was aborted", "AbortError");
    const request = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", request);
    await expect(
      fetchSpeech(
        "Een synthetische testzin.",
        controller.signal,
        "neutral",
        "nl",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
});
