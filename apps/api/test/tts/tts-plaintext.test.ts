import { Readable } from "node:stream";
import { Logger } from "@nestjs/common";
import { MsEdgeTTS } from "msedge-tts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsService } from "../../src/tts/tts.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("plain-text speech synthesis", () => {
  it("redacts configured credentials before synthesis and cached audio", async () => {
    const secret = "synthetic-tts-credential-fixture-123456";
    vi.stubEnv("NOVA_TTS_TEST_TOKEN", secret);
    const service = new TtsService();
    const engine = vi.fn(async (text: string) => Buffer.from(text));
    service.engine = engine;
    const result = await service.speak(
      `Dit bevat ${secret} en password=another-fixture-value.`,
    );
    expect(engine.mock.calls[0]?.[0]).not.toContain(secret);
    expect(engine.mock.calls[0]?.[0]).not.toContain("another-fixture-value");
    expect(engine.mock.calls[0]?.[0]).toContain("[redacted]");
    expect(result.audio.toString()).not.toContain(secret);
  });

  it("encodes XML text before the SDK interpolates it into SSML", async () => {
    vi.spyOn(MsEdgeTTS.prototype, "setMetadata").mockResolvedValue();
    const stream = vi.spyOn(MsEdgeTTS.prototype, "toStream").mockReturnValue({
      audioStream: Readable.from([Buffer.from("audio")]),
      metadataStream: null,
    });
    const close = vi
      .spyOn(MsEdgeTTS.prototype, "close")
      .mockImplementation(() => {});
    const result = await new TtsService().speak(
      'Onderzoek & ontwikkeling: 2 < 3 > 1; "tekst".',
      "nl-NL-FennaNeural",
    );
    expect(stream).toHaveBeenCalledWith(
      'Onderzoek &amp; ontwikkeling: 2 &lt; 3 &gt; 1; "tekst".',
      expect.any(Object),
    );
    expect(result.audio).toEqual(Buffer.from("audio"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the client even when connection metadata initialization fails", async () => {
    const diagnostic = new Error("private-tts.invalid token=fixture-secret");
    vi.spyOn(MsEdgeTTS.prototype, "setMetadata").mockRejectedValue(diagnostic);
    const stream = vi.spyOn(MsEdgeTTS.prototype, "toStream");
    const close = vi
      .spyOn(MsEdgeTTS.prototype, "close")
      .mockImplementation(() => {});
    const warning = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    await expect(
      new TtsService().speak("Een synthetische testzin.", "nl-NL-FennaNeural"),
    ).rejects.toBe(diagnostic);
    expect(stream).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      diagnostic.message,
    );
  });
});
