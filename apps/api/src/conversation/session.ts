import { Logger } from "@nestjs/common";
import { rms, resample, STT_RATE, encodeWav } from "./audio.js";
import { SentenceChunker, forSpeech } from "./sentences.js";
import type { SttPort } from "./stt.js";
import {
  DEFAULT_SEGMENTER,
  UtteranceSegmenter,
  type SegmenterOptions,
} from "./vad.js";

/** Where a conversation's audio goes and comes from. The phone link and (later) the browser implement it. */
export interface AudioTransport {
  /** Sample rate of the audio the transport takes in and plays out. */
  readonly rate: number;
  /** Queue samples for playback (paced by the transport). */
  play(samples: Int16Array): void;
  /** Drop everything queued but not yet played (barge-in). Resolves the number of queued ms dropped. */
  clear(): void;
  /** Samples still queued, in ms; used to know when speech has finished. */
  queuedMs(): number;
  close(): void;
}

export interface TurnInput {
  sessionId: string;
  message: string;
  language: "nl" | "en";
  signal: AbortSignal;
  emit: (event: string, data: Record<string, unknown>) => void;
}
export interface TurnResult {
  reply: string;
  confirmation?: unknown;
  unavailable?: boolean;
}

export interface SessionDeps {
  stt: SttPort;
  /** Text to 16 kHz mono PCM. */
  speak(text: string, signal: AbortSignal): Promise<Int16Array>;
  /** One question and answer through NOVA's normal chat pipeline, read-only tools only. */
  turn(input: TurnInput): Promise<TurnResult>;
  now?: () => number;
}

export interface SessionOptions {
  id: string;
  language: "nl" | "en";
  greeting: string;
  idleMs: number;
  maxMs: number;
  maxTurns: number;
  /** Say a short filler when the model has produced nothing after this long (default 2500 ms). */
  fillerAfterMs?: number;
  segmenter?: SegmenterOptions;
  onEnd?: (reason: string) => void;
  /** For tests: no real timers. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export type SessionState =
  "greeting" | "listening" | "thinking" | "speaking" | "closed";

const BYE =
  /\b(tot ziens|doei|dag nova|dag dag|ophangen|hang maar op|that'?s all|goodbye|bye bye|bedankt dat was het|dat was het)\b/i;

const TEXT = {
  nl: {
    fillers: ["Even kijken.", "Momentje.", "Ik zoek het even uit."],
    unclear:
      "Sorry, dat kon ik niet goed verstaan. Kun je het nog eens zeggen?",
    stuck:
      "Ik kan je op dit moment niet goed verstaan. Probeer het later nog eens. Tot ziens.",
    stillThere: "Ben je er nog?",
    idleBye: "Ik hoor niets meer, dus ik hang op. Tot ziens.",
    bye: "Tot ziens!",
    screen:
      "Dat moet je op het scherm bevestigen. Over de telefoon voer ik zoiets niet uit.",
    failed: "Daar ging iets mis. Probeer het zo nog eens.",
    maxTime:
      "Ons gesprek duurt al lang, dus ik hang nu op. Bel gerust opnieuw. Tot ziens.",
    busy: "Ik ben al in gesprek. Probeer het straks nog eens.",
  },
  en: {
    fillers: ["One moment.", "Let me check.", "Looking into it."],
    unclear: "Sorry, I couldn't hear that well. Could you say it again?",
    stuck: "I can't understand you right now. Please try again later. Goodbye.",
    stillThere: "Are you still there?",
    idleBye: "I can't hear anything, so I'm hanging up. Goodbye.",
    bye: "Goodbye!",
    screen:
      "That needs confirmation on the screen. I won't do that over the phone.",
    failed: "Something went wrong. Please try again in a moment.",
    maxTime:
      "We've been talking for a while, so I'm hanging up now. Call again any time. Goodbye.",
    busy: "I'm already in a conversation. Please try again later.",
  },
} as const;
export const PHRASES = TEXT;

/**
 * One spoken conversation. It listens for utterances, turns them into text, asks NOVA's normal chat
 * pipeline (read-only tools, streaming) and speaks the answer sentence by sentence while the model
 * is still writing. The caller can interrupt at any time; silence ends the call politely.
 */
export class ConversationSession {
  private readonly log = new Logger("NOVA conversation");
  private readonly segmenter: UtteranceSegmenter;
  private readonly t: (typeof TEXT)["nl"] | (typeof TEXT)["en"];
  private stateValue: SessionState = "greeting";
  private turn?: AbortController;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private idleStage = 0;
  private failures = 0;
  private turns = 0;
  private fillerIndex = 0;
  private closing = false;
  readonly startedAt: number;
  private readonly timers: NonNullable<SessionOptions["timers"]>;

  constructor(
    private readonly deps: SessionDeps,
    private readonly transport: AudioTransport,
    private readonly options: SessionOptions,
  ) {
    this.t = TEXT[options.language];
    this.timers = options.timers ?? { setTimeout, clearTimeout };
    this.startedAt = (deps.now ?? Date.now)();
    this.segmenter = new UtteranceSegmenter(
      {
        onSpeechStart: () => this.onSpeechStart(),
        onUtterance: (samples) => this.onUtterance(samples),
      },
      options.segmenter ?? DEFAULT_SEGMENTER,
      STT_RATE,
    );
  }

  /** A getter, so a state change during an await is never narrowed away. */
  private get closed(): boolean {
    return (this.stateValue as SessionState) === "closed";
  }

  get state(): SessionState {
    return this.stateValue;
  }
  get id(): string {
    return this.options.id;
  }
  get turnCount(): number {
    return this.turns;
  }

  /** Greets the caller and starts the call timers. */
  async start(): Promise<void> {
    this.maxTimer = this.timers.setTimeout(
      () => void this.endWith(this.t.maxTime, "max_duration"),
      this.options.maxMs,
    );
    this.maxTimer.unref?.();
    await this.say(this.options.greeting);
    if (this.stateValue === "greeting") this.listen();
  }

  /** Audio from the caller at the transport's rate. */
  feed(samples: Int16Array): void {
    if (this.closed) return;
    const wide =
      this.transport.rate === STT_RATE
        ? samples
        : resample(samples, this.transport.rate, STT_RATE);
    this.segmenter.suppress =
      this.stateValue === "speaking" || this.stateValue === "greeting";
    this.segmenter.push(wide);
  }

  /** The caller hung up or the link broke. */
  close(reason = "hangup"): void {
    if (this.closed) return;
    this.stateValue = "closed";
    this.turn?.abort();
    this.clearTimers();
    this.transport.clear();
    this.options.onEnd?.(reason);
  }

  private listen(): void {
    if (this.closed) return;
    this.stateValue = "listening";
    this.segmenter.suppress = false;
    this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(
      () => void this.onIdle(),
      this.options.idleMs,
    );
    this.idleTimer.unref?.();
  }
  private clearIdle(): void {
    if (this.idleTimer) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
  private clearTimers(): void {
    this.clearIdle();
    if (this.maxTimer) this.timers.clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
  }

  private async onIdle(): Promise<void> {
    if (this.stateValue !== "listening" || this.segmenter.speaking)
      return this.armIdle();
    this.idleStage++;
    if (this.idleStage === 1) {
      await this.say(this.t.stillThere);
      this.listen();
    } else await this.endWith(this.t.idleBye, "idle");
  }

  private onSpeechStart(): void {
    this.clearIdle();
    this.idleStage = 0;
    if (this.stateValue === "speaking" || this.stateValue === "greeting") {
      // Barge-in: stop talking at once and listen.
      this.turn?.abort();
      this.transport.clear();
      this.stateValue = "listening";
    } else if (this.stateValue === "thinking") {
      // The caller spoke while NOVA was still working: the new utterance replaces this turn.
      this.turn?.abort();
      this.transport.clear();
      this.stateValue = "listening";
    }
  }

  private onUtterance(samples: Int16Array): void {
    if (this.closed) return;
    this.queue = this.queue
      .then(() => this.handle(samples))
      .catch((e) => this.log.warn(`turn failed: ${(e as Error).message}`));
  }

  private async handle(samples: Int16Array): Promise<void> {
    if (this.closed) return;
    this.stateValue = "thinking";
    const controller = new AbortController();
    this.turn?.abort();
    this.turn = controller;
    const stt = await this.deps.stt.transcribe(encodeWav(samples, STT_RATE), {
      language: this.options.language,
      signal: controller.signal,
    });
    if (controller.signal.aborted || this.closed) return;
    if (!stt.ok) {
      this.failures++;
      if (this.failures >= 3)
        return void (await this.endWith(this.t.stuck, "stt_failed"));
      await this.say(this.t.unclear, controller);
      return this.afterSpeech(controller);
    }
    if (!stt.text) return this.afterSpeech(controller); // noise: stay quiet and keep listening
    this.failures = 0;
    this.turns++;
    if (this.turns > this.options.maxTurns)
      return void (await this.endWith(this.t.maxTime, "max_turns"));
    if (BYE.test(stt.text) && stt.text.split(/\s+/).length <= 6)
      return void (await this.endWith(this.t.bye, "goodbye"));
    await this.reply(stt.text, controller);
    this.afterSpeech(controller);
  }

  private afterSpeech(controller: AbortController): void {
    if (controller.signal.aborted || this.closed) return;
    this.listen();
  }

  private async reply(
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const chunker = new SentenceChunker();
    let spoken = "";
    let toolSaid = false;
    const speakQueue: Promise<void>[] = [];
    // Synthesis starts as soon as a sentence is complete; playback keeps the order.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (sentence: string) => {
      const clean = forSpeech(sentence);
      if (!clean) return;
      const audio = this.deps
        .speak(clean, controller.signal)
        .catch(() => new Int16Array(0));
      chain = chain.then(async () => {
        const pcm = await audio;
        if (controller.signal.aborted || this.closed || !pcm.length) return;
        this.stateValue = "speaking";
        this.transport.play(resample(pcm, STT_RATE, this.transport.rate));
      });
      speakQueue.push(chain);
    };
    const slow = this.timers.setTimeout(() => {
      if (!controller.signal.aborted && !spoken.trim() && !toolSaid) {
        toolSaid = true;
        enqueue(this.t.fillers[this.fillerIndex++ % this.t.fillers.length]!);
      }
    }, this.options.fillerAfterMs ?? 2500);
    slow.unref?.();
    try {
      const result = await this.deps.turn({
        sessionId: `phone_${this.options.id}`,
        message: text,
        language: this.options.language,
        signal: controller.signal,
        emit: (event, data) => {
          if (controller.signal.aborted) return;
          if (event === "token" && typeof data.text === "string") {
            spoken += data.text;
            for (const sentence of chunker.push(data.text)) enqueue(sentence);
          } else if (event === "tool_start" && !toolSaid && !spoken) {
            toolSaid = true;
            enqueue(
              this.t.fillers[this.fillerIndex++ % this.t.fillers.length]!,
            );
          }
        },
      });
      if (controller.signal.aborted) return;
      const rest = chunker.flush();
      if (rest) enqueue(rest);
      if (result.confirmation) enqueue(this.t.screen);
      else if (!spoken.trim() && result.reply) enqueue(result.reply);
      else if (
        result.reply &&
        result.reply.startsWith(spoken.trim()) &&
        result.reply.length > spoken.trim().length + 1 &&
        !rest
      )
        enqueue(result.reply.slice(spoken.trim().length));
      else if (result.unavailable && !spoken.trim()) enqueue(this.t.failed);
    } catch {
      if (!controller.signal.aborted) enqueue(this.t.failed);
    }
    this.timers.clearTimeout(slow);
    await chain;
    await this.untilPlayed(controller);
  }

  /** Waits for queued playback to drain (or an interruption). */
  private async untilPlayed(controller: AbortController): Promise<void> {
    while (
      !controller.signal.aborted &&
      this.stateValue !== "closed" &&
      this.transport.queuedMs() > 0
    )
      await new Promise((resolve) => this.timers.setTimeout(resolve, 40));
  }

  private async say(
    text: string,
    controller: AbortController = new AbortController(),
  ): Promise<void> {
    if (this.closed) return;
    const wasGreeting = this.stateValue === "greeting";
    const pcm = await this.deps
      .speak(forSpeech(text), controller.signal)
      .catch(() => new Int16Array(0));
    if (controller.signal.aborted || this.closed || !pcm.length) return;
    if (!wasGreeting) this.stateValue = "speaking";
    this.transport.play(resample(pcm, STT_RATE, this.transport.rate));
    await this.untilPlayed(controller);
  }

  private async endWith(text: string, reason: string): Promise<void> {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.clearTimers();
    this.turn?.abort();
    this.transport.clear();
    await this.say(text, new AbortController());
    this.transport.close();
    this.close(reason);
  }
}

export { rms };
