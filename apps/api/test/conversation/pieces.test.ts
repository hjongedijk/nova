import { describe, expect, it, vi } from "vitest";
import {
  encodeWav,
  resample,
  rms,
  tone,
  wavToPcm16k,
  STT_RATE,
} from "../../src/conversation/audio.js";
import {
  SentenceChunker,
  forSpeech,
} from "../../src/conversation/sentences.js";
import { cleanTranscript, OmniRouteStt } from "../../src/conversation/stt.js";
import { UtteranceSegmenter } from "../../src/conversation/vad.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

const silence = (ms: number, rate = STT_RATE) =>
  new Int16Array((rate * ms) / 1000);
const noise = (ms: number, level = 60) => {
  const out = new Int16Array((STT_RATE * ms) / 1000);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed % (2 * level + 1)) - level;
  }
  return out;
};

describe("audio helpers", () => {
  it("measures rms and resamples between rates", () => {
    expect(rms(tone(16000, 100, 440, 10000))).toBeCloseTo(7071, -2);
    expect(rms(new Int16Array(0))).toBe(0);
    expect(resample(tone(16000, 100), 16000, 8000)).toHaveLength(800);
    expect(resample(tone(8000, 100), 8000, 16000)).toHaveLength(1600);
    const same = tone(8000, 10);
    expect(resample(same, 8000, 8000)).toBe(same);
  });
  it("round-trips a WAV", () => {
    const samples = tone(16000, 50);
    expect(Array.from(wavToPcm16k(encodeWav(samples, 16000)))).toEqual(
      Array.from(samples),
    );
  });
});

describe("utterance segmenter", () => {
  function run(parts: Int16Array[], suppress = false) {
    const events: string[] = [];
    const utterances: { length: number; voiced: number }[] = [];
    const seg = new UtteranceSegmenter({
      onSpeechStart: () => events.push("start"),
      onUtterance: (s, v) => utterances.push({ length: s.length, voiced: v }),
    });
    seg.suppress = suppress;
    for (const p of parts) {
      // feed in odd-sized chunks to prove framing works across calls
      for (let i = 0; i < p.length; i += 137) seg.push(p.subarray(i, i + 137));
    }
    return { events, utterances };
  }

  it("cuts one utterance from speech surrounded by silence, with pre-roll and a short tail", () => {
    const r = run([noise(500), tone(STT_RATE, 1000), noise(1500)]);
    expect(r.events).toEqual(["start"]);
    expect(r.utterances).toHaveLength(1);
    const ms = (r.utterances[0]!.length / STT_RATE) * 1000;
    expect(ms).toBeGreaterThan(1100);
    expect(ms).toBeLessThan(1700);
    expect(r.utterances[0]!.voiced).toBeGreaterThan(900);
  });

  it("separates two utterances and ignores a click", () => {
    const click = tone(STT_RATE, 40);
    const r = run([
      noise(400),
      click,
      noise(1200),
      tone(STT_RATE, 600),
      noise(1200),
      tone(STT_RATE, 700, 300),
      noise(1200),
    ]);
    expect(r.utterances).toHaveLength(2);
  });

  it("keeps a short pause inside one utterance", () => {
    const r = run([
      tone(STT_RATE, 500),
      silence(400),
      tone(STT_RATE, 500),
      noise(1500),
    ]);
    expect(r.utterances).toHaveLength(1);
  });

  it("does not trigger on constant low hum", () => {
    expect(run([noise(5000, 200)]).utterances).toHaveLength(0);
  });

  it("needs a longer burst to interrupt while NOVA is speaking (echo protection)", () => {
    expect(
      run([noise(300), tone(STT_RATE, 200), noise(1200)], true).events,
    ).toEqual([]);
    expect(
      run([noise(300), tone(STT_RATE, 500), noise(1200)], true).events,
    ).toEqual(["start"]);
  });

  it("caps an endless utterance", () => {
    const events: number[] = [];
    const seg = new UtteranceSegmenter(
      {
        onSpeechStart: () => undefined,
        onUtterance: (s) => events.push(s.length),
      },
      undefined,
    );
    seg.push(tone(STT_RATE, 26_000));
    expect(events.length).toBe(1);
    expect(events[0]! / STT_RATE).toBeLessThanOrEqual(25.2);
  });
});

describe("sentence chunker and speech cleaning", () => {
  it("releases sentences as they complete and flushes the rest", () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const piece of [
      "Het is vandaag ",
      "zonnig in Amsterdam. Mor",
      "gen wordt het ",
      "bewolkt! En de ",
      "wind",
    ])
      out.push(...c.push(piece));
    expect(out).toEqual([
      "Het is vandaag zonnig in Amsterdam.",
      "Morgen wordt het bewolkt!",
    ]);
    expect(c.flush()).toBe("En de wind");
    expect(c.flush()).toBeNull();
  });
  it("does not cut inside decimals or times", () => {
    const c = new SentenceChunker();
    const out = [
      ...c.push("Het is 21.5 graden en de zon schijnt vandaag lang. "),
      ...c.push("Tot straks."),
    ];
    expect(out[0]).toBe("Het is 21.5 graden en de zon schijnt vandaag lang.");
  });
  it("merges a very short sentence into the next and cuts very long ones", () => {
    const c = new SentenceChunker(14, 80);
    expect(c.push("Ja. Het is precies half drie in de middag. ")).toEqual([
      "Ja. Het is precies half drie in de middag.",
    ]);
    const long = new SentenceChunker(14, 80).push("woord, ".repeat(30));
    expect(long.length).toBeGreaterThan(0);
    expect(long.every((s) => s.length <= 80)).toBe(true);
  });
  it("cleans markdown, links, code and emoji for speech", () => {
    expect(
      forSpeech(
        "**Hoi** `x` [site](https://a.nl) 😀\n- punt\n```js\nlet a\n```",
      ),
    ).toBe("Hoi x site punt");
    expect(forSpeech("Kijk op https://example.com/x nu")).toBe(
      "Kijk op een link nu",
    );
  });
});

describe("speech-to-text gating", () => {
  it("drops silence hallucinations and empty text", () => {
    for (const bad of [
      "",
      " ",
      "...",
      "Ondertitels ingediend door de Amara.org gemeenschap",
      "Bedankt voor het kijken!",
      "Thank you.",
      "you",
    ])
      expect(cleanTranscript(bad), bad).toBe("");
    expect(cleanTranscript("Hoe laat is het in Amsterdam?")).toBe(
      "Hoe laat is het in Amsterdam?",
    );
  });

  const config = (over: Record<string, unknown> = {}) =>
    ({
      omniKey: "k",
      omniUrl: "http://omni/v1",
      sttModel: "cloudflare/@cf/openai/whisper-large-v3-turbo",
      sttMode: "transcriptions",
      sttFreeVerified: true,
      ...over,
    }) as unknown as NovaConfig;
  const routing = (allowed = true) =>
    ({
      assertFreeModel: vi.fn(() => {
        if (!allowed) throw new Error("no");
      }),
    }) as never;

  it("sends nothing unless a free model is declared and inside the verified scope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const none = new OmniRouteStt(config({ sttModel: "" }), routing());
    expect(none.unavailable()).toMatch(/niet ingesteld/);
    expect(
      await none.transcribe(Buffer.alloc(10), { language: "nl" }),
    ).toMatchObject({ ok: false });
    const unverified = new OmniRouteStt(
      config({ sttFreeVerified: false }),
      routing(),
    );
    expect(unverified.unavailable()).toMatch(/NOVA_STT_FREE_VERIFIED/);
    const outside = await new OmniRouteStt(config(), routing(false)).transcribe(
      Buffer.alloc(10),
      { language: "nl" },
    );
    expect(outside).toMatchObject({
      ok: false,
      error: expect.stringContaining("buiten de geverifieerde gratis"),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses /audio/transcriptions with the model, language and a vocabulary hint", async () => {
    let seen: { url: string; form: FormData; auth: string } | undefined;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        seen = {
          url: String(url),
          form: init!.body as FormData,
          auth: String((init!.headers as Record<string, string>).authorization),
        };
        return new Response(JSON.stringify({ text: " Hoe laat is het? " }), {
          status: 200,
        });
      });
    const r = await new OmniRouteStt(config(), routing()).transcribe(
      encodeWav(tone(16000, 200), 16000),
      { language: "nl" },
    );
    expect(r).toEqual({ ok: true, text: "Hoe laat is het?" });
    expect(seen!.url).toBe("http://omni/v1/audio/transcriptions");
    expect(seen!.auth).toBe("Bearer k");
    expect(seen!.form.get("model")).toBe(
      "cloudflare/@cf/openai/whisper-large-v3-turbo",
    );
    expect(seen!.form.get("language")).toBe("nl");
    expect(String(seen!.form.get("prompt"))).toContain("Nova");
    spy.mockRestore();
  });

  it("chat-audio mode sends input_audio to the chat route", async () => {
    let body:
      | { model: string; messages: { content: { type: string }[] }[] }
      | undefined;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_u, init) => {
        body = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Hallo Nova" } }] }),
          { status: 200 },
        );
      });
    const r = await new OmniRouteStt(
      config({
        sttMode: "chat-audio",
        sttModel: "gemini/gemini-3.1-flash-lite",
      }),
      routing(),
    ).transcribe(encodeWav(tone(16000, 200), 16000), { language: "nl" });
    expect(r).toEqual({ ok: true, text: "Hallo Nova" });
    expect(body!.model).toBe("gemini/gemini-3.1-flash-lite");
    expect(body!.messages[0]!.content.map((c) => c.type)).toEqual([
      "text",
      "input_audio",
    ]);
    spy.mockRestore();
  });

  it("reports provider failures without leaking details", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("secret details", { status: 500 }));
    const r = await new OmniRouteStt(config(), routing()).transcribe(
      Buffer.alloc(10),
      { language: "nl" },
    );
    expect(r).toMatchObject({ ok: false, retry: true });
    expect(JSON.stringify(r)).not.toContain("secret");
    spy.mockRestore();
  });
});
