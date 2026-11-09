import { clean, decodeEntities, htmlToText } from "./text.js";
import type { WorldHttp } from "./world.types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** The SearXNG engine that found it (google, bing, ...). */
  engine?: string;
  /** News results: publication time as SearXNG reports it. */
  published?: string;
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

export type SearchCategory = "general" | "news";

/** Normalise a SearXNG JSON answer; throws when it is not one, so the caller falls back. */
export function parseSearxng(body: unknown, limit: number): SearchResult[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results))
    throw new Error("SearXNG gaf geen geldige resultaten.");
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of results) {
    if (out.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || url.length > 2000 || seen.has(url))
      continue;
    seen.add(url);
    const title = clean(typeof row.title === "string" ? row.title : "").slice(
      0,
      200,
    );
    const snippet = clean(
      typeof row.content === "string" ? row.content : "",
    ).slice(0, 400);
    const engine =
      typeof row.engine === "string" ? row.engine.slice(0, 40) : undefined;
    const published =
      typeof row.publishedDate === "string"
        ? row.publishedDate.slice(0, 40)
        : undefined;
    out.push({
      title: title || url,
      url,
      snippet,
      ...(engine ? { engine } : {}),
      ...(published ? { published } : {}),
    });
  }
  return out;
}

/** NOVA's own SearXNG (`baseUrl` is operator configuration). Throws on any failure. */
export async function searxngSearch(
  http: WorldHttp,
  baseUrl: string,
  query: string,
  limit: number,
  options: { signal?: AbortSignal; category?: SearchCategory } = {},
): Promise<SearchResult[]> {
  if (!http.getServiceJson) throw new Error("Geen SearXNG-verbinding.");
  const base = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: "nl",
    safesearch: "1",
  });
  if (options.category === "news") params.set("categories", "news");
  const body = await http.getServiceJson(`${base}/search?${params}`, {
    allowedBase: base,
    signal: options.signal,
    timeoutMs: 8000,
    maxBytes: 1_000_000,
  });
  return parseSearxng(body, limit);
}

export interface WebSearchOptions {
  /** SearXNG base URL; empty skips it. */
  searxngUrl?: string;
  category?: SearchCategory;
  /** Called when SearXNG fails, before falling back (for a log line). */
  onFallback?: (reason: string) => void;
}

export interface WebSearchOutcome {
  provider: "searxng" | "duckduckgo" | "wikipedia";
  results: SearchResult[];
}

/**
 * Search results from NOVA's own SearXNG first; when that fails or finds nothing, DuckDuckGo's HTML page,
 * and Wikipedia when that page has none either.
 */
export async function webSearch(
  http: WorldHttp,
  query: string,
  limit = 5,
  signal?: AbortSignal,
  options: WebSearchOptions = {},
): Promise<WebSearchOutcome> {
  if (options.searxngUrl) {
    try {
      const results = await searxngSearch(
        http,
        options.searxngUrl,
        query,
        limit,
        { signal, category: options.category },
      );
      if (results.length) return { provider: "searxng", results };
      options.onFallback?.("no results");
    } catch (error) {
      if (signal?.aborted) throw error;
      options.onFallback?.(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const page = await http.getPage(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=nl-nl`,
    { signal, accept: "text/html" },
  );
  const results = parseDuckDuckGo(page.body, limit);
  if (results.length) return { provider: "duckduckgo", results };
  const wiki = await http.getJson<WikiSearch>(
    `https://nl.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`,
    signal,
  );
  return {
    provider: "wikipedia",
    results: (wiki?.query?.search ?? []).map((item) => ({
      title: item.title,
      url: `https://nl.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
      snippet: clean(item.snippet ?? ""),
    })),
  };
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
