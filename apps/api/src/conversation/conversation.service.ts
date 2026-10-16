import {
  Inject,
  Injectable,
  Optional,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import type net from "node:net";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { OrchestratorService } from "../chat/orchestrator.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { decodeToPhoneWav } from "../telephony/announce.js";
import { TtsService } from "../tts/tts.service.js";
import { resample, wavToPcm16k } from "./audio.js";
import { AudioSocketServer, type AudioSocketTransport } from "./audiosocket.js";
import {
  ConversationSettingsStore,
  type ConversationSettings,
} from "./conversation.settings.js";
import {
  ConversationSession,
  PHRASES,
  type SessionDeps,
  type TurnInput,
  type TurnResult,
} from "./session.js";
import { STT_PORT, type SttPort } from "./stt.js";

export interface ConversationStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  /** Where Asterisk must connect (host:port as written into the dialplan). */
  dialTarget: string;
  speechToText: {
    ready: boolean;
    problem: string | null;
    model: string | null;
    mode: string;
  };
  active: { id: string; state: string; turns: number; seconds: number } | null;
  calls: number;
}

/** NOVA's spoken conversations. The phone is the first transport; the session code is transport-agnostic. */
@Injectable()
export class ConversationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("NOVA conversation");
  private readonly server: AudioSocketServer;
  private active?: ConversationSession;
  private calls = 0;
  private outbound?: { opening: string; expires: number };
  private readonly listeners = new Set<() => void>();
  /** Replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly settings: ConversationSettingsStore,
    @Inject(STT_PORT) private readonly stt: SttPort,
    private readonly tts: TtsService,
    private readonly orchestrator: OrchestratorService,
    private readonly events: JarvisStateStore,
    private readonly audit: AuditService,
    private readonly config: NovaConfig,
    @Optional() private readonly memory?: SessionMemoryService,
  ) {
    this.server = new AudioSocketServer(() => this.settings.get().secretUuid, {
      onCall: (transport, socket) => this.onCall(transport, socket),
    });
  }

  get port(): number {
    const raw = Number(process.env.NOVA_AUDIOSOCKET_PORT);
    return Number.isInteger(raw) && raw > 1023 && raw < 65536 ? raw : 8093;
  }
  private get bind(): string {
    return process.env.NOVA_AUDIOSOCKET_BIND?.trim() || "0.0.0.0";
  }
  /** The address Asterisk dials; in Compose that is the NOVA service name. */
  get dialHost(): string {
    return process.env.NOVA_AUDIOSOCKET_HOST?.trim() || "nova";
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    if (this.settings.get().enabled)
      await this.start().catch((e) =>
        this.log.warn(`could not listen: ${(e as Error).message}`),
      );
  }

  async onModuleDestroy(): Promise<void> {
    this.active?.close("shutdown");
    await this.server.close();
  }

  /** What the Asterisk dialplan needs, or null while conversations are off. */
  dialplan(): { host: string; port: number; uuid: string } | null {
    const s = this.settings.get();
    return s.enabled
      ? { host: this.dialHost, port: this.port, uuid: s.secretUuid }
      : null;
  }

  async start(): Promise<void> {
    await this.server.listen(this.port, this.bind);
  }

  /** The Asterisk dialplan depends on these settings; the telephony module re-renders when they change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setSettings(
    change: Parameters<ConversationSettingsStore["update"]>[0],
  ): Promise<ConversationSettings> {
    const next = this.settings.update(change);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener must not block the change */
      }
    }
    if (next.enabled) await this.start();
    else {
      this.active?.close("disabled");
      await this.server.close();
    }
    return next;
  }

  /** Why speech recognition cannot run, or null. */
  sttProblem(): string | null {
    return this.stt.unavailable();
  }

  /** NOVA is calling someone: the next conversation connection opens with this text. Expires after 90 seconds. */
  expectOutbound(opening: string): void {
    this.outbound = {
      opening: opening.slice(0, 300),
      expires: this.now() + 90_000,
    };
  }
  cancelOutbound(): void {
    this.outbound = undefined;
  }

  status(): ConversationStatus {
    const s = this.settings.get();
    const problem = this.stt.unavailable();
    return {
      enabled: s.enabled,
      listening: this.server.listening,
      port: this.port,
      dialTarget: `${this.dialHost}:${this.port}`,
      speechToText: {
        ready: !problem,
        problem,
        model: this.config.sttModel || null,
        mode: this.config.sttMode,
      },
      active: this.active
        ? {
            id: this.active.id,
            state: this.active.state,
            turns: this.active.turnCount,
            seconds: Math.round((this.now() - this.active.startedAt) / 1000),
          }
        : null,
      calls: this.calls,
    };
  }

  private deps(): SessionDeps {
    return {
      stt: this.stt,
      speak: (text, signal) => this.speak(text, signal),
      turn: (input) => this.turn(input),
      now: this.now,
    };
  }

  /** Text to 16 kHz PCM through the normal TTS service (Piper or Edge). */
  async speak(text: string, signal: AbortSignal): Promise<Int16Array> {
    if (!text.trim() || signal.aborted) return new Int16Array(0);
    const { audio, contentType } = await this.tts.speak(text);
    if (signal.aborted) return new Int16Array(0);
    return wavToPcm16k(await decodeToPhoneWav(audio, contentType));
  }

  /** One turn through NOVA's normal chat pipeline: streaming, session memory, and read-only tools only. */
  async turn(input: TurnInput): Promise<TurnResult> {
    const result = await this.orchestrator.run({
      sessionId: input.sessionId,
      message: input.message,
      inputMode: "voice",
      responseLanguage: input.language,
      stream: true,
      emit: input.emit,
      signal: input.signal,
      readOnlyOnly: true,
    });
    // The next turn of this call must remember this one, exactly like typed chat does.
    if (!result.unavailable) {
      this.memory?.add(input.sessionId, "user", input.message);
      this.memory?.add(input.sessionId, "assistant", result.reply);
    }
    return {
      reply: result.reply,
      confirmation: result.confirmation,
      unavailable: result.unavailable,
    };
  }

  private onCall(transport: AudioSocketTransport, socket: net.Socket) {
    const s = this.settings.get();
    if (!s.enabled) return null;
    if (this.active) {
      // One conversation at a time keeps the free model quotas safe; tell the caller and hang up.
      const busy = PHRASES[s.language].busy;
      void this.speak(busy, new AbortController().signal)
        .then(
          (pcm) =>
            pcm.length && transport.play(pcm.length ? resampleTo8k(pcm) : pcm),
        )
        .finally(() => setTimeout(() => transport.close(), 2500).unref());
      return { onAudio: () => undefined, onHangup: () => undefined };
    }
    const id = crypto.randomBytes(5).toString("hex");
    const planned =
      this.outbound && this.outbound.expires > this.now()
        ? this.outbound
        : undefined;
    this.outbound = undefined;
    const session = new ConversationSession(this.deps(), transport, {
      id,
      language: s.language,
      greeting: planned?.opening ?? s.greeting,
      idleMs: s.idleSeconds * 1000,
      maxMs: s.maxMinutes * 60_000,
      maxTurns: 80,
      onEnd: (reason) => this.ended(session, reason),
    });
    this.active = session;
    this.calls++;
    this.record("started", {
      call: id,
      from: socket.remoteAddress,
      direction: planned ? "outbound" : "inbound",
    });
    if (!planned)
      this.alert(
        s.language === "nl"
          ? "Telefoongesprek met NOVA"
          : "Phone conversation with NOVA",
        s.language === "nl"
          ? "Er is een gesprek gestart."
          : "A conversation started.",
      );
    void session.start().catch(() => session.close("error"));
    return {
      onAudio: (samples: Int16Array) => session.feed(samples),
      onHangup: (reason: string) => session.close(reason),
      onDtmf: (digit: string) => {
        if (digit === "#" || digit === "*") session.close("dtmf");
      },
    };
  }

  private ended(session: ConversationSession, reason: string): void {
    if (this.active === session) this.active = undefined;
    // Only metadata: no transcript text goes into the audit log.
    this.record("ended", {
      call: session.id,
      reason,
      turns: session.turnCount,
      seconds: Math.round((this.now() - session.startedAt) / 1000),
    });
  }

  private record(phase: string, extra: Record<string, unknown>): void {
    try {
      this.audit.record({
        sessionId: "conversation",
        tool: "conversation",
        phase,
        ...extra,
      });
    } catch {
      /* the audit log must not stop a call */
    }
  }

  private alert(title: string, detail: string): void {
    try {
      this.events.emit({
        topic: "jarvis/alerts",
        payload: {
          title,
          detail,
          severity: "info",
          key: "conversation",
          at: new Date(this.now()).toISOString(),
        },
      });
    } catch {
      /* alerts are best effort */
    }
  }

  /** Ends the running call (settings stop button). */
  hangUp(): boolean {
    if (!this.active) return false;
    this.active.close("operator");
    return true;
  }
}

function resampleTo8k(pcm: Int16Array): Int16Array {
  return resample(pcm, 16000, 8000);
}
