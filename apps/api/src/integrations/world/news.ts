import type { NewsHeadlines, NewsItem } from "@nova/contracts";
import { clean, firstSentence } from "./text.js";
import type { WorldHttp } from "./world.types.js";

export interface ConfiguredNewsFeed {
  name: string;
  url: string;
}

export function parseNewsFeeds(raw: string): ConfiguredNewsFeed[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, 5).flatMap((entry): ConfiguredNewsFeed[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.name !== "string" || typeof row.url !== "string")
        return [];
      const name = row.name
        .trim()
        .replace(/[^\p{L}\p{N} _().-]/gu, "")
        .slice(0, 50);
      try {
        const url = new URL(row.url);
        if (
          !name ||
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return [];
        return [{ name, url: url.toString() }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export const NEWS_FEEDS: Record<string, string> = {
  algemeen: "nosnieuwsalgemeen",
  binnenland: "nosnieuwsbinnenland",
  buitenland: "nosnieuwsbuitenland",
  politiek: "nosnieuwspolitiek",
  economie: "nosnieuwseconomie",
  tech: "nosnieuwstech",
  cultuur: "nosnieuwscultuurenmedia",
  opmerkelijk: "nosnieuwsopmerkelijk",
  sport: "nossportalgemeen",
};

export function parseRss(xml: string, limit: number): NewsItem[] {
  const field = (item: string, name: string) => {
    const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(
      item,
    );
    if (!match) return "";
    return clean((match[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, limit)
    .map((match) => {
      const item = match[1] ?? "";
      return {
        title: field(item, "title"),
        summary: field(item, "description"),
        link: field(item, "link"),
        published: field(item, "pubDate"),
      };
    });
}

/** Returns null when the feed has no stories. */
export async function newsHeadlines(
  http: WorldHttp,
  topic = "algemeen",
  count = 4,
  signal?: AbortSignal,
  configured: ConfiguredNewsFeed[] = [],
): Promise<NewsHeadlines | null> {
  if (configured.length) {
    const feeds = configured.slice(0, 5);
    const results = await Promise.allSettled(
      feeds.map(async (source) => {
        const page = await http.getPage(source.url, {
          signal,
          accept: "application/rss+xml,text/xml",
          maxBytes: 500_000,
          timeoutMs: 7000,
        });
        return parseRss(page.body, count).map((item) => ({
          ...item,
          summary: firstSentence(item.summary, 180),
          source: source.name,
        }));
      }),
    );
    const items = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .slice(0, Math.min(10, Math.max(1, count)));
    if (!items.length) return null;
    return {
      source: "jouw RSS-bronnen",
      topic: "algemeen",
      items,
      hint: "Vertel dit als een kort gesproken verhaal van drie of vier zinnen over wat het meest opvalt. Noem de bron per bericht. Geen opsomming, geen nummers, geen opmaak, alleen berichten uit dit resultaat. Bied aan om meer te vertellen.",
    };
  }
  const feed = NEWS_FEEDS[topic] ?? NEWS_FEEDS["algemeen"];
  const page = await http.getPage(`https://feeds.nos.nl/${feed}`, {
    signal,
    accept: "application/rss+xml,text/xml",
  });
  const items = parseRss(page.body, count).map((item) => ({
    ...item,
    summary: firstSentence(item.summary, 180),
  }));
  if (!items.length) return null;
  return {
    source: "NOS",
    topic,
    items,
    hint: "Vertel dit als een kort gesproken verhaal van drie of vier zinnen over wat het meest opvalt. Geen opsomming, geen nummers, geen opmaak, alleen berichten uit dit resultaat. Bied aan om meer te vertellen.",
  };
}
