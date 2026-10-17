/** CPIM (RFC 3862) envelope as used by Linphone for chat messages: CPIM headers, blank line, MIME headers, blank line, body. */

export const MAX_TEXT_BYTES = 8 * 1024;

export type CpimResult =
  | { kind: "text"; body: Buffer }
  | { kind: "notification" }
  | { kind: "unreadable"; reason: string };

/** Delivery and typing notifications carry no text for NOVA. */
export const NOTIFICATION_TYPES = new Set([
  "application/im-iscomposing+xml",
  "message/imdn+xml",
]);

export function parseContentType(value: string | undefined): {
  type: string;
  charset: string | null;
} {
  const [rawType = "", ...params] = (value ?? "").split(";");
  let charset: string | null = null;
  for (const param of params) {
    const m = /^\s*charset\s*=\s*"?([^"\s;]+)"?\s*$/i.exec(param);
    if (m) charset = m[1]!.toLowerCase();
  }
  return { type: rawType.trim().toLowerCase(), charset };
}

const BLANK = /\r?\n\r?\n/;

export function parseCpim(body: Buffer): CpimResult {
  const text = body.toString("latin1"); // one char per byte: indexes map straight back to the buffer
  const first = BLANK.exec(text);
  if (!first) return { kind: "unreadable", reason: "no CPIM header end" };
  const at = first.index + first[0].length;
  let innerHeaders = "";
  let bodyStart: number;
  const empty = /^\r?\n/.exec(text.slice(at));
  if (empty) {
    bodyStart = at + empty[0].length;
  } else {
    const second = BLANK.exec(text.slice(at));
    if (second) {
      innerHeaders = text.slice(at, at + second.index);
      bodyStart = at + second.index + second[0].length;
    } else {
      innerHeaders = text.slice(at);
      bodyStart = text.length;
    }
  }
  let inner: string | undefined;
  let length: number | null = null;
  for (const line of innerHeaders.split(/\r?\n/)) {
    const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (name === "content-type") inner = m[2]!.trim();
    if (name === "content-length" && /^\d{1,9}$/.test(m[2]!.trim()))
      length = Number(m[2]!.trim());
  }
  if (!inner) return { kind: "unreadable", reason: "no inner Content-Type" };
  const { type, charset } = parseContentType(inner);
  if (NOTIFICATION_TYPES.has(type)) return { kind: "notification" };
  if (type !== "text/plain")
    return { kind: "unreadable", reason: `inner type ${type}` };
  let content = body.subarray(bodyStart);
  if (length !== null && length <= content.length)
    content = content.subarray(0, length);
  if (content.length > MAX_TEXT_BYTES)
    return { kind: "unreadable", reason: "text too large" };
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      const decoded = new TextDecoder(charset, { fatal: true }).decode(content);
      content = Buffer.from(decoded, "utf8");
    } catch {
      return { kind: "unreadable", reason: "unsupported charset" };
    }
  }
  return { kind: "text", body: Buffer.from(content) };
}
