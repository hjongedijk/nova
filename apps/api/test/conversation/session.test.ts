import { afterEach, describe, expect, it, vi } from "vitest";
import { tone, STT_RATE } from "../../src/conversation/audio.js";
import {
  ConversationSession,
  PHRASES,
  type AudioTransport,
  type SessionDeps,
  type TurnInput,
  type TurnResult,
} from "../../src/conversation/session.js";
import type { SttResult } from "../../src/conversation/stt.js";

class FakeTransport implements AudioTransport {
  rate = 8000;
  played: { ms: number }[] = [];
  cleared = 0;
  closed = false;
  /** Milliseconds of audio that stay "queued" after play(), to simulate speaking in progress. */
  hold = 0;
  private queued = 0;
  play(samples: Int16Array) {
    const ms = (samples.length / this.rate) * 1000;
    this.played.push({ ms });
    this.queued += this.hold;
  }
  clear() {
    this.cleared++;
    this.queued = 0;
  }
  queuedMs() {
    return this.queued;
  }
  release() {
    this.queued = 0;
  }
  close() {
    this.closed = true;
  }
}

interface Harness {
  session: ConversationSession;
  transport: FakeTransport;
  spoken: string[];
  turns: TurnInput[];
  sttCalls: number;
  ended: string[];
}

function build(over: {
  stt?: (n: number) => SttResult;
  turn?: (input: TurnInput) => Promise<TurnResult>;
  idleMs?: number;
  maxMs?: number;
  maxTurns?: number;
  fillerAfterMs?: number;
  hold?: number;
  greeting?: string;
}): Harness {
  const transport = new FakeTransport();
  transport.hold = over.hold ?? 0;
  const spoken: string[] = [];
  const turns: TurnInput[] = [];
  const ended: string[] = [];
  const h = { sttCalls: 0 } as Harness;
  const deps: SessionDeps = {
    stt: {
      unavailable: () => null,
      transcribe: async () =>
        over.stt?.(h.sttCalls++) ?? { ok: true, text: "Hoe laat is het?" },
    },
    speak: async (text) => {
      spoken.push(text);
      return tone(STT_RATE, 100);
    },
    turn:
      over.turn ??
      (async (input) => {
        input.emit("token", { text: "Het is half drie. " });
        input.emit("token", { text: "Fijne dag!" });
        return { reply: "Het is half drie. Fijne dag!" };
      }),
  };
  const wrapped: SessionDeps = {
    ...deps,
    turn: async (i) => (turns.push(i), deps.turn(i)),
  };
  const session = new ConversationSession(wrapped, transport, {
    id: "abc",
    language: "nl",
    greeting: over.greeting ?? "Hallo, met Nova.",
    idleMs: over.idleMs ?? 10_000,
    maxMs: over.maxMs ?? 60_000,
    maxTurns: over.maxTurns ?? 50,
    fillerAfterMs: over.fillerAfterMs,
    onEnd: (r) => ended.push(r),
  });
  Object.assign(h, { session, transport, spoken, turns, ended });
  return h;
}

/** 20 ms frames at the transport rate (8 kHz phone audio). */
function frames(h: Harness, kind: "speech" | "silence", ms: number) {
  const n = ms / 20;
  const speech = tone(8000, 20, 300, 9000);
  for (let i = 0; i < n; i++)
    h.session.feed(kind === "speech" ? speech : new Int16Array(160));
}
const talk = (h: Harness, ms = 800) => {
  frames(h, "silence", 200);
  frames(h, "speech", ms);
  frames(h, "silence", 1400);
};
const started = async (h: Harness) => {
  await h.session.start();
  expect(h.session.state).toBe("listening");
};

afterEach(() => vi.restoreAllMocks());

describe("conversation session", () => {
  it("greets, listens, answers sentence by sentence and keeps listening", async () => {
    const h = build({});
    await started(h);
    expect(h.spoken).toEqual(["Hallo, met Nova."]);
    talk(h);
    await vi.waitFor(() => expect(h.spoken).toContain("Fijne dag!"));
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({
      sessionId: "phone_abc",
      message: "Hoe laat is het?",
      language: "nl",
    });
    expect(h.spoken.slice(1)).toEqual(["Het is half drie.", "Fijne dag!"]);
    await vi.waitFor(() => expect(h.session.state).toBe("listening"));
    // a second turn works
    talk(h);
    await vi.waitFor(() => expect(h.turns).toHaveLength(2));
  });

  it("says a short filler when a tool runs before any words, and only once", async () => {
    const h = build({
      turn: async (i) => {
        i.emit("tool_start", { name: "weather" });
        i.emit("tool_start", { name: "clock" });
        i.emit("token", { text: "Het wordt zonnig vandaag in de stad." });
        return { reply: "Het wordt zonnig vandaag in de stad." };
      },
    });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.spoken.length).toBeGreaterThanOrEqual(3));
    expect(PHRASES.nl.fillers).toContain(h.spoken[1]);
    expect(
      h.spoken.filter((s) =>
        (PHRASES.nl.fillers as readonly string[]).includes(s),
      ),
    ).toHaveLength(1);
  });

  it("says a filler when the model is slow, but not when it answers quickly", async () => {
    const slow = build({
      fillerAfterMs: 60,
      turn: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { reply: "Het antwoord is eindelijk klaar." };
      },
    });
    await started(slow);
    talk(slow);
    await vi.waitFor(() =>
      expect(slow.spoken).toContain("Het antwoord is eindelijk klaar."),
    );
    expect(
      (PHRASES.nl.fillers as readonly string[]).includes(slow.spoken[1]!),
    ).toBe(true);
    const fast = build({ fillerAfterMs: 500 });
    await started(fast);
    talk(fast);
    await vi.waitFor(() => expect(fast.spoken).toContain("Fijne dag!"));
    expect(
      fast.spoken.some((s) =>
        (PHRASES.nl.fillers as readonly string[]).includes(s),
      ),
    ).toBe(false);
  });

  it("speaks the final reply when the model streamed nothing, and the missing tail when it was cut", async () => {
    const a = build({ turn: async () => ({ reply: "Alles is in orde." }) });
    await started(a);
    talk(a);
    await vi.waitFor(() => expect(a.spoken).toContain("Alles is in orde."));
    const b = build({
      turn: async (i) => {
        i.emit("token", { text: "Eerste deel van het antwoord. " });
        return { reply: "Eerste deel van het antwoord. Tweede deel erbij." };
      },
    });
    await started(b);
    talk(b);
    await vi.waitFor(() => expect(b.spoken.at(-1)).toBe("Tweede deel erbij."));
  });

  it("lets the caller interrupt: playback is cleared and the old turn is aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aborted = false;
    const h = build({
      turn: async (i) => {
        i.signal.addEventListener("abort", () => (aborted = true));
        i.emit("token", {
          text: "Dit is een heel lang antwoord dat niemand wil horen. ",
        });
        await gate;
        return {
          reply: "Dit is een heel lang antwoord dat niemand wil horen.",
        };
      },
    });
    await started(h);
    h.transport.hold = 100_000;
    talk(h);
    await vi.waitFor(() => expect(h.session.state).toBe("speaking"));
    const before = h.transport.cleared;
    frames(h, "speech", 600); // longer than the echo-protection burst
    expect(h.transport.cleared).toBeGreaterThan(before);
    expect(aborted).toBe(true);
    expect(h.session.state).toBe("listening");
    release();
  });

  it("does not let a short echo burst interrupt her", async () => {
    const h = build({
      turn: async (i) => {
        i.emit("token", {
          text: "Dit is een lang antwoord met genoeg woorden erin. ",
        });
        await new Promise((r) => setTimeout(r, 400));
        return { reply: "Dit is een lang antwoord met genoeg woorden erin." };
      },
    });
    await started(h);
    h.transport.hold = 100_000;
    talk(h);
    await vi.waitFor(() => expect(h.session.state).toBe("speaking"));
    const before = h.transport.cleared;
    frames(h, "speech", 200);
    frames(h, "silence", 1000);
    expect(h.transport.cleared).toBe(before);
    expect(h.session.state).toBe("speaking");
    h.session.close();
  });

  it("asks again when the speech was not understood, and hangs up after three failures", async () => {
    const h = build({ stt: () => ({ ok: false, error: "x", retry: true }) });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.spoken).toContain(PHRASES.nl.unclear));
    talk(h);
    talk(h);
    await vi.waitFor(() => expect(h.ended).toEqual(["stt_failed"]));
    expect(h.spoken).toContain(PHRASES.nl.stuck);
    expect(h.transport.closed).toBe(true);
    expect(h.turns).toHaveLength(0);
  });

  it("stays quiet on noise or hallucinated text", async () => {
    const h = build({ stt: () => ({ ok: true, text: "" }) });
    await started(h);
    talk(h);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.turns).toHaveLength(0);
    expect(h.spoken).toEqual(["Hallo, met Nova."]);
    expect(h.session.state).toBe("listening");
  });

  it("says goodbye and hangs up on a goodbye phrase, but not inside a long sentence", async () => {
    const h = build({ stt: () => ({ ok: true, text: "Oké, tot ziens." }) });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.ended).toEqual(["goodbye"]));
    expect(h.spoken).toContain(PHRASES.nl.bye);
    expect(h.turns).toHaveLength(0);

    const g = build({
      stt: () => ({
        ok: true,
        text: "Kun je mij vertellen hoe laat het is en daarna doei zeggen tegen de buren?",
      }),
    });
    await started(g);
    talk(g);
    await vi.waitFor(() => expect(g.turns).toHaveLength(1));
    expect(g.ended).toEqual([]);
  });

  it("never performs a confirmation over the phone", async () => {
    const h = build({
      turn: async () => ({
        reply: "Zal ik de deur openen?",
        confirmation: { id: "c1" },
      }),
    });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.spoken).toContain(PHRASES.nl.screen));
  });

  it("recovers from a failing turn and keeps the call open", async () => {
    let n = 0;
    const h = build({
      turn: async () => {
        if (n++ === 0) throw new Error("model down");
        return { reply: "Nu werkt het weer prima." };
      },
    });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.spoken).toContain(PHRASES.nl.failed));
    expect(h.ended).toEqual([]);
    talk(h);
    await vi.waitFor(() =>
      expect(h.spoken).toContain("Nu werkt het weer prima."),
    );
  });

  it("asks if the caller is still there, then hangs up", async () => {
    const h = build({ idleMs: 80 });
    await started(h);
    await vi.waitFor(() => expect(h.spoken).toContain(PHRASES.nl.stillThere));
    await vi.waitFor(() => expect(h.ended).toEqual(["idle"]));
    expect(h.spoken).toContain(PHRASES.nl.idleBye);
    expect(h.transport.closed).toBe(true);
  });

  it("speech resets the idle prompt", async () => {
    const h = build({ idleMs: 200 });
    await started(h);
    await new Promise((r) => setTimeout(r, 120));
    talk(h, 400);
    await vi.waitFor(() => expect(h.turns).toHaveLength(1));
    expect(h.spoken).not.toContain(PHRASES.nl.stillThere);
  });

  it("ends a call that runs too long, and after too many turns", async () => {
    const t = build({ maxMs: 100 });
    await started(t);
    await vi.waitFor(() => expect(t.ended).toEqual(["max_duration"]));
    const m = build({ maxTurns: 1 });
    await started(m);
    talk(m);
    await vi.waitFor(() => expect(m.turns).toHaveLength(1));
    await vi.waitFor(() => expect(m.session.state).toBe("listening"));
    talk(m);
    await vi.waitFor(() => expect(m.ended).toEqual(["max_turns"]));
  });

  it("a hang-up during a turn aborts it and ignores later audio", async () => {
    let aborted = false;
    const h = build({
      turn: async (i) => {
        i.signal.addEventListener("abort", () => (aborted = true));
        await new Promise((r) => setTimeout(r, 300));
        return { reply: "te laat" };
      },
    });
    await started(h);
    talk(h);
    await vi.waitFor(() => expect(h.turns).toHaveLength(1));
    h.session.close("hangup");
    expect(aborted).toBe(true);
    expect(h.ended).toEqual(["hangup"]);
    frames(h, "speech", 400);
    await new Promise((r) => setTimeout(r, 350));
    expect(h.spoken).not.toContain("te laat");
  });

  it("works with 16 kHz transports too", async () => {
    const h = build({});
    h.transport.rate = 16000;
    await h.session.start();
    const speech = tone(16000, 20, 300, 9000);
    for (let i = 0; i < 10; i++) h.session.feed(new Int16Array(320));
    for (let i = 0; i < 40; i++) h.session.feed(speech);
    for (let i = 0; i < 70; i++) h.session.feed(new Int16Array(320));
    await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  });
});
