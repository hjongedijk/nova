import crypto from "node:crypto";

/** Minimal SIP-over-stream framing and header helpers for the relay. Bodies are never interpreted here. */

export class SipFramingError extends Error {}

export interface SipHeader {
  /** Lower-case, long form (`content-type`, never `c`). */
  name: string;
  /** Unfolded, trimmed value. */
  value: string;
  /** The original (possibly folded) lines, without line endings. */
  lines: string[];
}

export interface SipMessage {
  startLine: string;
  isRequest: boolean;
  /** Request method; empty for responses. */
  method: string;
  headers: SipHeader[];
  body: Buffer;
  /** The complete message exactly as it arrived. */
  raw: Buffer;
}

export type FrameItem =
  { type: "raw"; bytes: Buffer } | { type: "message"; message: SipMessage };

export interface FramerLimits {
  maxHead: number;
  maxBody: number;
}

export const DEFAULT_FRAMER_LIMITS: FramerLimits = {
  maxHead: 16 * 1024,
  maxBody: 1024 * 1024,
};

const COMPACT: Record<string, string> = {
  v: "via",
  f: "from",
  t: "to",
  i: "call-id",
  c: "content-type",
  l: "content-length",
  m: "contact",
};
const REQUEST_LINE = /^([A-Za-z]{1,32}) \S{1,2048} SIP\/2\.0$/;
const RESPONSE_LINE = /^SIP\/2\.0 \d{3}(?: .*)?$/;

export function parseHead(head: string): {
  startLine: string;
  headers: SipHeader[];
} {
  const lines = head.split("\r\n");
  const startLine = lines.shift() ?? "";
  const headers: SipHeader[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      const last = headers[headers.length - 1];
      if (!last) throw new SipFramingError("folded line without header");
      last.lines.push(line);
      last.value = `${last.value} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) throw new SipFramingError("malformed header line");
    const raw = line.slice(0, colon).trim().toLowerCase();
    headers.push({
      name: COMPACT[raw] ?? raw,
      value: line.slice(colon + 1).trim(),
      lines: [line],
    });
  }
  return { startLine, headers };
}

export const header = (message: SipMessage, name: string) =>
  message.headers.find((h) => h.name === name)?.value;

function contentLength(headers: SipHeader[]): number {
  let found: number | null = null;
  for (const h of headers) {
    if (h.name !== "content-length") continue;
    if (!/^\d{1,9}$/.test(h.value))
      throw new SipFramingError("invalid Content-Length");
    const n = Number(h.value);
    if (found !== null && found !== n)
      throw new SipFramingError("conflicting Content-Length");
    found = n;
  }
  return found ?? 0;
}

/**
 * Splits a SIP byte stream into messages (framed by Content-Length) and bare CR/LF keepalive bytes between them
 * (RFC 5626 ping/pong). Throws SipFramingError for anything that cannot be a SIP message; the caller closes the connection.
 */
export class SipFramer {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly limits: FramerLimits = DEFAULT_FRAMER_LIMITS) {}

  get pending(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): FrameItem[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const items: FrameItem[] = [];
    for (;;) {
      if (!this.buffer.length) break;
      const first = this.buffer[0]!;
      if (first === 0x0d || first === 0x0a) {
        let end = 0;
        while (
          end < this.buffer.length &&
          (this.buffer[end] === 0x0d || this.buffer[end] === 0x0a)
        )
          end++;
        items.push({ type: "raw", bytes: this.buffer.subarray(0, end) });
        this.buffer = this.buffer.subarray(end);
        continue;
      }
      const headEnd = this.buffer.indexOf("\r\n\r\n", 0, "latin1");
      if (headEnd < 0) {
        if (this.buffer.length > this.limits.maxHead)
          throw new SipFramingError("header section too large");
        break;
      }
      if (headEnd > this.limits.maxHead)
        throw new SipFramingError("header section too large");
      const { startLine, headers } = parseHead(
        this.buffer.toString("latin1", 0, headEnd),
      );
      const request = REQUEST_LINE.exec(startLine);
      if (!request && !RESPONSE_LINE.test(startLine))
        throw new SipFramingError("not a SIP start line");
      const length = contentLength(headers);
      if (length > this.limits.maxBody)
        throw new SipFramingError("body too large");
      const total = headEnd + 4 + length;
      if (this.buffer.length < total) break;
      const raw = this.buffer.subarray(0, total);
      items.push({
        type: "message",
        message: {
          startLine,
          isRequest: Boolean(request),
          method: request ? request[1]!.toUpperCase() : "",
          headers,
          body: raw.subarray(headEnd + 4),
          raw,
        },
      });
      this.buffer = this.buffer.subarray(total);
    }
    // Do not keep a view on a large chunk alive for a few leftover bytes.
    if (this.buffer.length) this.buffer = Buffer.from(this.buffer);
    return items;
  }
}

/** Re-serialises a message with a new body: Content-Type replaced, Content-Length fixed, every other header line verbatim. */
export function withBody(
  message: SipMessage,
  contentType: string,
  body: Buffer,
): Buffer {
  const lines: string[] = [message.startLine];
  for (const h of message.headers) {
    if (h.name === "content-type" || h.name === "content-length") continue;
    lines.push(...h.lines);
  }
  lines.push(`Content-Type: ${contentType}`, `Content-Length: ${body.length}`);
  return Buffer.concat([
    Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"),
    body,
  ]);
}

/** A bodiless 200 OK for a request: Via, From, To (with a tag), Call-ID and CSeq are copied. */
export function okResponse(message: SipMessage): Buffer {
  const lines = ["SIP/2.0 200 OK"];
  for (const h of message.headers.filter((x) => x.name === "via"))
    lines.push(...h.lines);
  for (const h of message.headers.filter((x) => x.name === "from"))
    lines.push(...h.lines);
  for (const h of message.headers.filter((x) => x.name === "to")) {
    const line = h.lines.join(" ");
    lines.push(
      /;\s*tag=/i.test(line)
        ? line
        : `${line.replace(/\s+$/, "")};tag=${crypto.randomBytes(5).toString("hex")}`,
    );
  }
  for (const name of ["call-id", "cseq"])
    for (const h of message.headers.filter((x) => x.name === name))
      lines.push(...h.lines);
  lines.push("Content-Length: 0");
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

/**
 * Removes the topmost Route header element when it points at the relay itself (a proxy removes its own Route entry,
 * RFC 3261 16.4); without it the registrar would try to forward everything to the relay's address. Other bytes untouched.
 */
export function stripOwnRoute(
  message: SipMessage,
  own: Array<{ host: string; port: number }>,
): Buffer {
  if (!message.isRequest) return message.raw;
  const index = message.headers.findIndex((h) => h.name === "route");
  if (index < 0) return message.raw;
  const route = message.headers[index]!;
  const elements = route.value.split(/,(?=\s*(?:"[^"]*"\s*)?<)/);
  const match = /<sip:(?:[^@>]*@)?([^:;>]+)(?::(\d+))?[;>]/i.exec(
    elements[0] ?? "",
  );
  const host = match?.[1]?.toLowerCase();
  const port = Number(match?.[2] ?? 5060);
  if (
    !host ||
    !own.some((o) => o.host.toLowerCase() === host && o.port === port)
  )
    return message.raw;
  const lines = [message.startLine];
  message.headers.forEach((h, i) => {
    if (i !== index) lines.push(...h.lines);
    else if (elements.length > 1)
      lines.push(`Route: ${elements.slice(1).join(",").trim()}`);
  });
  return Buffer.concat([
    Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"),
    message.body,
  ]);
}
