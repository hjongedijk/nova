/*
 * Pure helpers for NOVA's windows: which video player an address needs, which addresses may be shown at all, and
 * the big "result" windows built from real tool results (a reader view for web_read, a document for files).
 * Everything that leaves here is display text: sanitised, masked and capped.
 */
import type { NovaVideoSource, NovaWindowEvent } from "@nova/contracts";
import {
  maskSecrets,
  previewDomain,
  previewText,
} from "../chat/tool-preview.js";

export const READER_MAX_CHARS = 24_000;

/** http(s) only, no userinfo, at most 2000 characters. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Seconds from t=90, t=1m30s or start=90. */
function startSeconds(url: URL): number | undefined {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (!raw) return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!match) return undefined;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return seconds > 0 && seconds < 86400 ? seconds : undefined;
}

/** The player for a video address: YouTube, Vimeo, a direct file or an HLS playlist. Null when it is not a video. */
export function videoSource(value: unknown): NovaVideoSource | null {
  const href = safeHttpUrl(value);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/^(?:www\.|m\.|music\.)/, "");
  const start = startSeconds(url);
  const withStart = (source: NovaVideoSource): NovaVideoSource =>
    start ? { ...source, start } : source;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id =
      url.searchParams.get("v") ??
      /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1];
    return id && YOUTUBE_ID.test(id)
      ? withStart({ provider: "youtube", id })
      : null;
  }
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id && YOUTUBE_ID.test(id)
      ? withStart({ provider: "youtube", id })
      : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = /\/(?:video\/)?(\d{5,12})(?:$|[/?#])/.exec(url.pathname)?.[1];
    return id ? withStart({ provider: "vimeo", id }) : null;
  }
  if (/\.m3u8$/i.test(url.pathname)) return { provider: "hls", url: href };
  if (/\.(?:mp4|webm|ogv|mov|m4v)$/i.test(url.pathname))
    return withStart({ provider: "file", url: href });
  return null;
}

/** Window id from a tool step: stable per turn step so an update lands in the same window. */
export const windowId = (prefix: string, seed: string | number) =>
  `${prefix}-${
    String(seed)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 40) || "x"
  }`;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;

/** Text for a reader or document window: line breaks kept, secrets masked, control characters out, capped. */
export function readerText(value: unknown, max = READER_MAX_CHARS): string {
  if (typeof value !== "string") return "";
  const clean = maskSecrets(value)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A big window worth opening for a finished step, from the real result only. */
export function resultWindowFor(
  name: string,
  args: Rec | null | undefined,
  result: unknown,
  step: number,
): NovaWindowEvent | undefined {
  const outcome = rec(result);
  if (!outcome || outcome.ok !== true) return undefined;
  const data = rec(outcome.result) ?? outcome;
  if (name === "web_read") {
    const url = safeHttpUrl(data.url) ?? safeHttpUrl(args?.url);
    const text = readerText(data.text ?? data.content);
    if (!text) return undefined;
    return {
      id: windowId("reader", step),
      kind: "reader",
      title: previewText(data.title, 160) || previewDomain(url) || "Pagina",
      ...(url ? { url, domain: previewDomain(url) } : {}),
      text,
      result: true,
    };
  }
  if (name === "wikipedia") {
    const text = readerText(data.extract ?? data.summary ?? data.text);
    if (!text) return undefined;
    const url = safeHttpUrl(data.url);
    return {
      id: windowId("reader", step),
      kind: "reader",
      title: previewText(data.title ?? args?.query, 160) || "Wikipedia",
      domain: "wikipedia.org",
      ...(url ? { url } : {}),
      text,
      result: true,
    };
  }
  return undefined;
}
