import { Injectable } from "@nestjs/common";
import type { YoutubeVideo } from "@nova/contracts";

/*
 * Finds the first real video for a search, so "speel X op YouTube" can open the video itself
 * instead of a page of results. Uses the same search API as the YouTube website: no key,
 * and no cookie wall like the HTML pages have.
 */
const ENDPOINT = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const VIDEOS_ONLY = "EgIQAQ%3D%3D";

interface Renderer {
  videoId?: string;
  title?: TextNode;
  ownerText?: TextNode;
  longBylineText?: TextNode;
  lengthText?: TextNode;
  upcomingEventData?: unknown;
  badges?: unknown[];
}
interface TextNode {
  simpleText?: string;
  runs?: { text: string }[];
}

export type YoutubePost = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

// Every videoRenderer in the response, wherever it is nested.
function* renderers(node: unknown): Generator<Renderer> {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const direct = record.videoRenderer as Renderer | undefined;
  if (direct?.videoId) yield direct;
  for (const value of Array.isArray(node) ? node : Object.values(record))
    yield* renderers(value);
}

const textOf = (value?: TextNode) =>
  value?.simpleText ?? value?.runs?.map((run) => run.text).join("") ?? "";

/** A title short enough to say out loud: cut at the first separator or decoration. */
export function spokenTitle(title: unknown): string {
  const clean = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = (clean.split(/\s+[|\-–—]\s+|\s*[[(★✨]/)[0] ?? "").trim();
  const base = cut.length >= 8 ? cut : clean;
  return base.length > 60 ? `${base.slice(0, 57).trimEnd()}…` : base;
}

export function pickVideo(response: unknown): YoutubeVideo | null {
  const found = [...renderers(response)]
    .filter((item) => /^[\w-]{11}$/.test(item.videoId ?? ""))
    // Ads carry no length; live streams and premieres show a badge instead of one.
    .filter((item) => item.lengthText && !item.upcomingEventData)
    .filter(
      (item) =>
        !/\b(?:live|premiere)\b/i.test(JSON.stringify(item.badges ?? [])),
    );
  const best = found[0];
  if (!best?.videoId) return null;
  return {
    videoId: best.videoId,
    title: textOf(best.title),
    shortTitle: spokenTitle(textOf(best.title)),
    channel: textOf(best.ownerText) || textOf(best.longBylineText),
    duration: textOf(best.lengthText),
    url: `https://www.youtube.com/watch?v=${best.videoId}`,
  };
}

const defaultPost: YoutubePost = async (body, signal) => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(10000),
    headers: {
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "accept-language": "nl",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`YouTube antwoordde met ${response.status}`);
  return response.json();
};

@Injectable()
export class YoutubeService {
  async findVideo(
    query: string,
    options: { post?: YoutubePost; signal?: AbortSignal } = {},
  ): Promise<YoutubeVideo | null> {
    const { post = defaultPost, signal } = options;
    const context = {
      client: {
        clientName: "WEB",
        clientVersion: "2.20240912.01.00",
        hl: "nl",
        gl: "NL",
      },
    };
    // Videos only first; if that finds nothing, everything, so a channel name still works.
    for (const params of [VIDEOS_ONLY, undefined]) {
      const video = pickVideo(
        await post({ context, query, ...(params ? { params } : {}) }, signal),
      );
      if (video) return video;
    }
    return null;
  }
}
