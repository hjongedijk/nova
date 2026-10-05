import { clean, decodeEntities, htmlToText } from "./text.js";
import type { WorldHttp } from "./world.types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const links = [
    ...html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    ),
  ];
  const snippets = [
    ...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const link = links[i] as RegExpMatchArray;
    const raw = decodeEntities(link[1] ?? "");
    const target = /[?&]uddg=([^&]+)/.exec(raw)?.[1];
    const url = target
      ? decodeURIComponent(target)
      : raw.startsWith("//")
        ? `https:${raw}`
        : raw;
    if (!/^https?:\/\//.test(url)) continue;
    if (/duckduckgo\.com\/y\.js|[?&]ad_/.test(url)) continue; // ads
    results.push({
      title: clean(link[2] ?? ""),
      url,
      snippet: snippets[i] ? clean(snippets[i]?.[1] ?? "") : "",
    });
  }
  return results;
}

interface WikiSearch {
  query?: { search?: { title: string; snippet?: string }[] };
}

/** Search results, from DuckDuckGo, or from Wikipedia when that page has none. */
export async function webSearch(
  http: WorldHttp,
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const page = await http.getPage(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=nl-nl`,
    { signal, accept: "text/html" },
  );
  let results = parseDuckDuckGo(page.body, limit);
  if (!results.length) {
    const wiki = await http.getJson<WikiSearch>(
      `https://nl.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`,
      signal,
    );
    results = (wiki?.query?.search ?? []).map((item) => ({
      title: item.title,
      url: `https://nl.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
      snippet: clean(item.snippet ?? ""),
    }));
  }
  return results;
}

export interface PageText {
  url: string;
  title: string;
  untrusted: true;
  truncated: boolean;
  text: string;
}

/** Throws a Dutch message for pages that cannot be read. */
export async function webRead(
  http: WorldHttp,
  url: string,
  signal?: AbortSignal,
): Promise<PageText> {
  const page = await http.getPage(url, {
    signal,
    accept: "text/html,text/plain,application/json",
  });
  const type = String(page.headers["content-type"] ?? "");
  if (!/text\/|json|xml/i.test(type))
    throw new Error(`Niet-leesbaar paginatype: ${type || "onbekend"}`);
  const { title, text } = /html/i.test(type)
    ? htmlToText(page.body)
    : { title: "", text: page.body.replace(/\s+/g, " ").trim() };
  if (!text) throw new Error("De pagina bevat geen leesbare tekst.");
  return {
    url: page.url,
    title,
    untrusted: true,
    truncated: text.length > 6000,
    text: text.slice(0, 6000),
  };
}

interface WikiSummary {
  title: string;
  description?: string;
  extract: string;
  content_urls?: { desktop?: { page?: string } };
}

/** Null when Wikipedia knows nothing about the query. */
export async function wikipedia(
  http: WorldHttp,
  query: string,
  language = "nl",
  signal?: AbortSignal,
) {
  const search = await http.getJson<WikiSearch>(
    `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`,
    signal,
  );
  const title = search?.query?.search?.[0]?.title;
  if (!title) return null;
  const page = await http.getJson<WikiSummary>(
    `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    signal,
  );
  return {
    title: page.title,
    description: page.description ?? null,
    summary: page.extract,
    url: page.content_urls?.desktop?.page,
    source: `Wikipedia (${language})`,
    note: "Dit is alleen de inleiding van het artikel. Staat het gevraagde (zeker een getal of jaartal) er niet in, zoek dan verder met web_search of web_read in plaats van te gokken.",
  };
}
