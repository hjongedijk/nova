import type { NewsHeadlines, NewsItem } from "@nova/contracts";
import { clean, firstSentence } from "./text.js";
import type { WorldHttp } from "./world.types.js";

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
): Promise<NewsHeadlines | null> {
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
