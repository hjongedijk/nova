/*
 * The page's one websocket to /api/live, shared by every live window. It opens with the first subscription,
 * resubscribes after a reconnect, and closes a few seconds after the last window stops watching.
 */
import type {
  LiveClientMessage,
  LiveFrameHeader,
  LiveStatusMessage,
  LiveStreamKind,
} from "@nova/contracts";

export interface LiveSubscription {
  stream: LiveStreamKind;
  display?: number;
  tab?: string;
  fps: number;
  maxWidth: number;
}

export interface LiveHandlers {
  frame(header: LiveFrameHeader, jpeg: Blob): void;
  status(status: LiveStatusMessage): void;
}

/** Split a binary frame message: 4-byte header length, JSON header, JPEG. */
export function decodeFrame(
  buffer: ArrayBuffer,
): { header: LiveFrameHeader; jpeg: Blob } | null {
  if (buffer.byteLength < 6) return null;
  const length = new DataView(buffer).getUint32(0);
  if (length <= 0 || length > 4096 || 4 + length >= buffer.byteLength)
    return null;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 4, length)),
    ) as LiveFrameHeader;
    if (typeof header?.key !== "string") return null;
    return {
      header,
      jpeg: new Blob([new Uint8Array(buffer, 4 + length)], {
        type: "image/jpeg",
      }),
    };
  } catch {
    return null;
  }
}

class LiveClient {
  private socket: WebSocket | null = null;
  private readonly subs = new Map<
    string,
    { spec: LiveSubscription; handlers: LiveHandlers }
  >();
  private retry = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(key: string, spec: LiveSubscription, handlers: LiveHandlers) {
    this.subs.set(key, { spec, handlers });
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.ensure();
    this.send({ type: "subscribe", key, ...spec });
    return () => this.unsubscribe(key);
  }

  budget(key: string, fps: number, maxWidth: number) {
    const sub = this.subs.get(key);
    if (!sub) return;
    if (
      Math.abs(sub.spec.fps - fps) < 0.25 &&
      Math.abs(sub.spec.maxWidth - maxWidth) < 64
    )
      return;
    sub.spec = { ...sub.spec, fps, maxWidth };
    this.send({ type: "budget", key, fps, maxWidth });
  }

  private unsubscribe(key: string) {
    if (!this.subs.delete(key)) return;
    this.send({ type: "unsubscribe", key });
    if (!this.subs.size && !this.closeTimer)
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (!this.subs.size) {
          this.socket?.close();
          this.socket = null;
        }
      }, 5000);
  }

  private send(message: LiveClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private ensure() {
    if (this.socket || this.reconnectTimer || typeof WebSocket === "undefined")
      return;
    const url = new URL("/api/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      for (const [key, { spec }] of this.subs)
        socket.send(JSON.stringify({ type: "subscribe", key, ...spec }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const status = JSON.parse(event.data) as LiveStatusMessage;
          if (status?.type === "status")
            this.subs.get(status.key)?.handlers.status(status);
        } catch {
          /* ignore */
        }
        return;
      }
      const frame = decodeFrame(event.data as ArrayBuffer);
      if (frame)
        this.subs
          .get(frame.header.key)
          ?.handlers.frame(frame.header, frame.jpeg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [key, { handlers }] of this.subs)
        handlers.status({
          type: "status",
          key,
          state: "connecting",
          reason: "Verbinding met NOVA wordt hersteld.",
        });
      if (!this.subs.size) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.subs.size) this.ensure();
      }, delay);
    };
  }
}

export const live = new LiveClient();
