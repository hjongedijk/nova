/*
 * Who gets which frame. Frames are never queued for a viewer: a frame is sent now or dropped.
 * - FrameGate: one viewer's subscription. Caps the rate (its fps budget), the size of one frame, and refuses when
 *   the viewer's socket still has a lot unsent (backpressure: a slow phone gets fewer frames, not older ones).
 * - BandwidthBudget: a token bucket shared by every live viewer, so many windows together stay under a cap.
 */
export const LIVE_LIMITS = {
  /** Frames per second one subscription may get. */
  maxFps: 24,
  minFps: 0.5,
  /** One frame, after the agent's own cap. */
  maxFrameBytes: 1_000_000,
  /** Unsent bytes on a viewer's socket above which frames are dropped. */
  maxBufferedBytes: 1_500_000,
  /** All live viewers together, bytes per second. */
  globalBytesPerSecond: 12_000_000,
  /** Live subscriptions one socket may hold, and sockets at once. */
  maxSubscriptions: 8,
  maxSockets: 6,
  maxWidth: 1920,
  minWidth: 240,
} as const;

export type GateVerdict = "send" | "rate" | "size" | "busy" | "bandwidth";

export const clampFps = (fps: unknown): number =>
  typeof fps === "number" && Number.isFinite(fps)
    ? Math.min(LIVE_LIMITS.maxFps, Math.max(LIVE_LIMITS.minFps, fps))
    : 4;

export const clampWidth = (width: unknown): number =>
  typeof width === "number" && Number.isFinite(width)
    ? Math.round(
        Math.min(LIVE_LIMITS.maxWidth, Math.max(LIVE_LIMITS.minWidth, width)),
      )
    : 960;

export class BandwidthBudget {
  private tokens: number;
  private at: number;
  constructor(
    private readonly rate: number,
    now = Date.now(),
  ) {
    this.tokens = rate;
    this.at = now;
  }
  take(bytes: number, now = Date.now()): boolean {
    this.tokens = Math.min(
      this.rate,
      this.tokens + (Math.max(0, now - this.at) / 1000) * this.rate,
    );
    this.at = now;
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
}

export class FrameGate {
  private last = -Infinity;
  sent = 0;
  dropped = 0;
  constructor(
    private fps: number,
    private readonly maxBytes: number = LIVE_LIMITS.maxFrameBytes,
  ) {
    this.fps = clampFps(fps);
  }
  get budgetFps(): number {
    return this.fps;
  }
  setFps(fps: number): void {
    this.fps = clampFps(fps);
  }
  /** Decide for one frame of `bytes`, with `buffered` bytes still unsent on the viewer's socket. */
  offer(
    bytes: number,
    buffered: number,
    now = Date.now(),
    budget?: BandwidthBudget,
  ): GateVerdict {
    const verdict: GateVerdict =
      bytes > this.maxBytes
        ? "size"
        : // A little slack so a stream at exactly the budget does not alternate.
          now - this.last < 1000 / this.fps - 4
          ? "rate"
          : buffered > LIVE_LIMITS.maxBufferedBytes
            ? "busy"
            : budget && !budget.take(bytes, now)
              ? "bandwidth"
              : "send";
    if (verdict === "send") {
      this.last = now;
      this.sent++;
    } else if (verdict !== "rate") this.dropped++;
    return verdict;
  }
}

/** Binary frame message: 4-byte big-endian header length, the JSON header, then the JPEG. */
export function encodeFrame(header: object, jpeg: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(head.length, 0);
  return Buffer.concat([size, head, jpeg]);
}
