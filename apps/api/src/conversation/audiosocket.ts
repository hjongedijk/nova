import crypto from "node:crypto";
import net from "node:net";
import { PHONE_RATE, pcmFromBuffer, bufferFromPcm } from "./audio.js";
import type { AudioTransport } from "./session.js";

/** Asterisk AudioSocket frame kinds (res_audiosocket). */
export const KIND = {
  hangup: 0x00,
  uuid: 0x01,
  dtmf: 0x03,
  audio: 0x10,
  error: 0xff,
} as const;

export function frame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 0xffff) throw new Error("AudioSocket frame too large");
  const out = Buffer.alloc(3 + payload.length);
  out[0] = kind;
  out.writeUInt16BE(payload.length, 1);
  payload.copy(out, 3);
  return out;
}

/** Parses the byte stream into frames; refuses oversized frames. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPayload = 4096) {}
  push(chunk: Buffer): { kind: number; payload: Buffer }[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const out: { kind: number; payload: Buffer }[] = [];
    for (;;) {
      if (this.buffer.length < 3) break;
      const length = this.buffer.readUInt16BE(1);
      if (length > this.maxPayload)
        throw new Error("AudioSocket frame too large");
      if (this.buffer.length < 3 + length) break;
      out.push({
        kind: this.buffer[0]!,
        payload: Buffer.from(this.buffer.subarray(3, 3 + length)),
      });
      this.buffer = this.buffer.subarray(3 + length);
    }
    return out;
  }
}

const FRAME_SAMPLES = (PHONE_RATE * 20) / 1000; // 160 samples = 20 ms of 8 kHz audio

/** Private and link-local addresses only: AudioSocket carries no authentication of its own. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, "");
  if (a === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return (
    x === 10 ||
    x === 127 ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254)
  );
}

/** Sends audio to Asterisk at real-time pace (20 ms frames) and supports instant clearing for barge-in. */
export class AudioSocketTransport implements AudioTransport {
  readonly rate = PHONE_RATE;
  private queue: Buffer[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private next = 0;
  private closed = false;
  private carry = new Int16Array(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly now: () => number = Date.now,
  ) {}

  play(samples: Int16Array): void {
    if (this.closed) return;
    let data = samples;
    if (this.carry.length) {
      data = new Int16Array(this.carry.length + samples.length);
      data.set(this.carry);
      data.set(samples, this.carry.length);
    }
    let offset = 0;
    while (data.length - offset >= FRAME_SAMPLES) {
      this.queue.push(
        bufferFromPcm(data.subarray(offset, offset + FRAME_SAMPLES)),
      );
      offset += FRAME_SAMPLES;
    }
    // Pad the last partial frame with silence so the tail is not lost.
    const rest = data.length - offset;
    if (rest > 0) {
      const padded = new Int16Array(FRAME_SAMPLES);
      padded.set(data.subarray(offset));
      this.queue.push(bufferFromPcm(padded));
    }
    this.carry = new Int16Array(0);
    this.pump();
  }

  clear(): void {
    this.queue = [];
    this.carry = new Int16Array(0);
  }

  queuedMs(): number {
    return this.queue.length * 20;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    // Let the last frames reach the caller before the connection ends the call leg.
    setTimeout(() => {
      try {
        this.socket.write(frame(KIND.hangup));
      } catch {
        /* socket already gone */
      }
      this.socket.end();
    }, 300).unref();
  }

  private pump(): void {
    if (this.timer || this.closed) return;
    this.next = this.now();
    this.tick();
  }

  private tick(): void {
    this.timer = undefined;
    if (this.closed || this.socket.destroyed) return;
    const chunk = this.queue.shift();
    if (!chunk) return; // idle until play() is called again
    try {
      this.socket.write(frame(KIND.audio, chunk));
    } catch {
      this.closed = true;
      return;
    }
    this.next += 20;
    this.timer = setTimeout(
      () => this.tick(),
      Math.max(0, this.next - this.now()),
    );
    this.timer.unref?.();
  }
}

export interface AudioSocketHandlers {
  /** Called once the first frame has proved knowledge of the shared secret. */
  onCall(
    transport: AudioSocketTransport,
    socket: net.Socket,
  ): {
    onAudio(samples: Int16Array): void;
    onHangup(reason: string): void;
    onDtmf?(digit: string): void;
  } | null;
}

/**
 * TCP server for Asterisk's AudioSocket(). A connection is accepted only from a private address and
 * only when its first frame carries NOVA's secret id (generated into the dialplan), within 3 seconds.
 */
export class AudioSocketServer {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  constructor(
    private readonly secret: () => string,
    private readonly handlers: AudioSocketHandlers,
  ) {}

  get listening(): boolean {
    return Boolean(this.server?.listening);
  }

  address(): net.AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a : null;
  }

  async listen(port: number, host: string): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    if (!isPrivateAddress(socket.remoteAddress)) return void socket.destroy();
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const parser = new FrameParser();
    let call: ReturnType<AudioSocketHandlers["onCall"]> = null;
    let transport: AudioSocketTransport | undefined;
    const reject = () => socket.destroy();
    const handshake = setTimeout(reject, 3000);
    handshake.unref();
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch {
        return reject();
      }
      for (const f of frames) {
        if (!call) {
          if (f.kind !== KIND.uuid || f.payload.length !== 16) return reject();
          const expected = Buffer.from(this.secret().replace(/-/g, ""), "hex");
          if (
            expected.length !== 16 ||
            !crypto.timingSafeEqual(expected, f.payload)
          )
            return reject();
          clearTimeout(handshake);
          transport = new AudioSocketTransport(socket);
          call = this.handlers.onCall(transport, socket);
          if (!call) return reject();
          continue;
        }
        if (f.kind === KIND.audio) call.onAudio(pcmFromBuffer(f.payload));
        else if (f.kind === KIND.dtmf)
          call.onDtmf?.(f.payload.toString("ascii"));
        else if (f.kind === KIND.hangup || f.kind === KIND.error) {
          // Tell the session once; the connection closing afterwards must not report a second end.
          const ending = call;
          call = null;
          ending.onHangup(f.kind === KIND.hangup ? "hangup" : "error");
          socket.end();
          return;
        }
      }
    });
    const gone = () => {
      clearTimeout(handshake);
      this.sockets.delete(socket);
      transport?.close();
      call?.onHangup("disconnected");
      call = null;
    };
    socket.once("close", gone);
    socket.on("error", () => undefined);
  }
}

export const uuidToBuffer = (uuid: string): Buffer =>
  Buffer.from(uuid.replace(/-/g, ""), "hex");
