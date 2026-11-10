/*
 * Reads the Windows agent's live stream (multipart/x-mixed-replace, boundary "novaframe"): every part has a
 * Content-Length, so frames are cut by length, never by scanning the JPEG. Anything malformed or oversized ends
 * the stream; the caller reconnects.
 */
import { sanitize } from "../core/security/sanitize.js";

export const MJPEG_BOUNDARY = "novaframe";
export const MAX_UPSTREAM_FRAME_BYTES = 1_500_000;
const MAX_HEAD_BYTES = 4096;

export interface MjpegPart {
  headers: Record<string, string>;
  body: Buffer;
}

export class MjpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: { headers: Record<string, string>; length: number } | null =
    null;
  finished = false;

  /** Feed bytes; returns the complete frames found. Throws on a broken stream. */
  push(chunk: Buffer): MjpegPart[] {
    if (this.finished) return [];
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const parts: MjpegPart[] = [];
    for (;;) {
      if (!this.pending) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > MAX_HEAD_BYTES)
            throw new Error("Live stream part header too large");
          const closing = this.buffer
            .toString("latin1")
            .replace(/^\s+/, "")
            .startsWith(`--${MJPEG_BOUNDARY}--`);
          if (closing) this.finished = true;
          return parts;
        }
        const head = this.buffer.subarray(0, end).toString("latin1");
        this.buffer = this.buffer.subarray(end + 4);
        const lines = head.replace(/^\s+/, "").split("\r\n");
        if (lines[0] !== `--${MJPEG_BOUNDARY}`)
          throw new Error("Live stream boundary missing");
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] = line
              .slice(colon + 1)
              .trim();
        }
        const length = Number(headers["content-length"]);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_UPSTREAM_FRAME_BYTES
        )
          throw new Error("Live stream frame length invalid");
        this.pending = { headers, length };
      }
      // Body plus its trailing CRLF.
      if (this.buffer.length < this.pending.length + 2) return parts;
      const body = Buffer.from(this.buffer.subarray(0, this.pending.length));
      this.buffer = this.buffer.subarray(this.pending.length + 2);
      parts.push({ headers: this.pending.headers, body });
      this.pending = null;
    }
  }
}

/** The agent's `X-Nova-Meta` JSON line, reduced to known display fields. */
export function frameMeta(raw: string | undefined): {
  url?: string;
  title?: string;
  tab?: string;
  vw?: number;
  vh?: number;
} {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const meta = value as Record<string, unknown>;
  const text = (field: unknown, max: number) =>
    typeof field === "string" && field
      ? sanitize(field).slice(0, max)
      : undefined;
  const size = (field: unknown) =>
    typeof field === "number" && field > 0 && field < 20000
      ? Math.round(field)
      : undefined;
  const url = text(meta.url, 600);
  return {
    ...(url && /^(?:https?:|about:blank)/i.test(url) ? { url } : {}),
    ...(text(meta.title, 200) ? { title: text(meta.title, 200) } : {}),
    ...(text(meta.tab, 64) && /^[A-Za-z0-9-]+$/.test(String(meta.tab))
      ? { tab: text(meta.tab, 64) }
      : {}),
    ...(size(meta.vw) ? { vw: size(meta.vw) } : {}),
    ...(size(meta.vh) ? { vh: size(meta.vh) } : {}),
  };
}
