import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { assertSkillTarget } from "../../src/core/security/safe-request.js";
import {
  WorldService,
  defaultWorldHttp,
  type WorldHttp,
} from "../../src/integrations/world/index.js";
import {
  assertServiceUrl,
  parseSearxng,
} from "../../src/integrations/world/index.js";

const SEARXNG = "http://searxng:8080";
const DDG_HTML = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.nl%2Fddg&amp;rut=1">DDG resultaat</a>
<a class="result__snippet" href="x">Uit DuckDuckGo</a>`;

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The real defaultWorldHttp for SearXNG (with a fake global fetch); DuckDuckGo and Wikipedia are fakes. */
function make(searxngUrl = SEARXNG) {
  const pages: string[] = [];
  const network: WorldHttp = {
    getServiceJson: defaultWorldHttp.getServiceJson!.bind(defaultWorldHttp),
    async getJson() {
      return { query: { search: [] } } as never;
    },
    async getPage(url) {
      pages.push(url);
      return { status: 200, headers: {}, body: DDG_HTML, url };
    },
  };
  const world = new WorldService(
    {
      dataFile: (name: string) => path.join(os.tmpdir(), name),
      homeLocation: null,
      searxngUrl,
    } as unknown as NovaConfig,
    network,
  );
  return { world, pages };
}

afterEach(() => vi.unstubAllGlobals());

describe("web_search through SearXNG", () => {
  it("uses SearXNG first and normalises its JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        query: "akkrum",
        results: [
          {
            url: "https://nl.wikipedia.org/wiki/Akkrum",
            title: "Akkrum - <b>Wikipedia</b>",
            content: "Akkrum is een dorp in Friesland.",
            engine: "bing",
            engines: ["bing", "duckduckgo"],
          },
          { url: "https://nl.wikipedia.org/wiki/Akkrum", title: "dubbel" },
          { url: "javascript:alert(1)", title: "geen web" },
          { url: "https://akkrum.net/", title: "", content: "x".repeat(900) },
          "rommel",
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { world, pages } = make();
    const out = await world.execute("web_search", { query: "akkrum" });
    expect(out.ok).toBe(true);
    const result = out.result as {
      provider: string;
      untrusted: boolean;
      results: {
        title: string;
        url: string;
        snippet: string;
        engine?: string;
      }[];
    };
    expect(result.provider).toBe("searxng");
    expect(result.untrusted).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: "Akkrum - Wikipedia",
      url: "https://nl.wikipedia.org/wiki/Akkrum",
      snippet: "Akkrum is een dorp in Friesland.",
      engine: "bing",
    });
    expect(result.results[1]?.title).toBe("https://akkrum.net/");
    expect(result.results[1]?.snippet.length).toBeLessThanOrEqual(400);
    expect(pages).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const called = new URL(url);
    expect(called.origin).toBe(SEARXNG);
    expect(called.pathname).toBe("/search");
    expect(called.searchParams.get("format")).toBe("json");
    expect(called.searchParams.get("language")).toBe("nl");
    expect(called.searchParams.get("q")).toBe("akkrum");
    expect(init.redirect).toBe("error");
  });

  it("asks the news category for news searches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        results: [
          {
            url: "https://nos.nl/artikel/1",
            title: "Kabinet",
            content: "Nieuws",
            engine: "bing news",
            publishedDate: "2026-11-09T09:34:00",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await make().world.execute("web_search", {
      query: "kabinet",
      category: "news",
    });
    const result = out.result as {
      category: string;
      results: { published?: string }[];
    };
    expect(result.category).toBe("news");
    expect(result.results[0]?.published).toBe("2026-11-09T09:34:00");
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("categories")).toBe("news");
  });

  it("falls back to DuckDuckGo when SearXNG fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const { world, pages } = make();
    const out = await world.execute("web_search", { query: "akkrum" });
    expect(out.ok).toBe(true);
    const result = out.result as {
      provider: string;
      results: { url: string }[];
    };
    expect(result.provider).toBe("duckduckgo");
    expect(result.results[0]?.url).toBe("https://example.nl/ddg");
    expect(pages[0]).toMatch(/^https:\/\/html\.duckduckgo\.com\//);
  });

  it("falls back on an HTTP error and on malformed JSON", async () => {
    for (const reply of [
      json({ error: "boom" }, 500),
      json("{not json"),
      json({ results: "nope" }),
      json({ results: [] }),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
      const out = await make().world.execute("web_search", { query: "x y" });
      expect((out.result as { provider: string }).provider).toBe("duckduckgo");
    }
  });

  it("goes straight to DuckDuckGo when SearXNG is switched off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await make("").world.execute("web_search", { query: "x y" });
    expect((out.result as { provider: string }).provider).toBe("duckduckgo");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses oversized SearXNG answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json({ results: [], pad: "x".repeat(1_100_000) })),
    );
    await expect(
      defaultWorldHttp.getServiceJson!(`${SEARXNG}/search?q=a`, {
        allowedBase: SEARXNG,
      }),
    ).rejects.toThrow("Response too large");
  });
});

describe("internal service allowance", () => {
  it("only allows the configured SearXNG origin and path", async () => {
    expect(assertServiceUrl(`${SEARXNG}/search?q=a`, SEARXNG).pathname).toBe(
      "/search",
    );
    expect(() =>
      assertServiceUrl("http://searxng:8081/search", SEARXNG),
    ).toThrow();
    expect(() => assertServiceUrl("http://qdrant:6333/", SEARXNG)).toThrow();
    expect(() =>
      assertServiceUrl("http://u:p@searxng:8080/search", SEARXNG),
    ).toThrow();
    expect(() =>
      assertServiceUrl("http://h/searxevil/search", "http://h/searx"),
    ).toThrow();
    expect(
      assertServiceUrl("http://h/searx/search", "http://h/searx/").pathname,
    ).toBe("/searx/search");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      defaultWorldHttp.getServiceJson!("http://169.254.169.254/latest", {
        allowedBase: SEARXNG,
      }),
    ).rejects.toThrow("configured internal service");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("model-controlled fetches still cannot reach SearXNG", async () => {
    await expect(
      defaultWorldHttp.getPage("http://searxng:8080/search?q=a"),
    ).rejects.toThrow();
    expect(() => assertSkillTarget("http://searxng:8080/")).toThrow();
    expect(() =>
      assertSkillTarget("http://searxng:8080/", { allowPrivate: true }),
    ).toThrow(/NOVA zelf/);
  });

  it("parseSearxng rejects a body without a results list", () => {
    expect(() => parseSearxng(null, 5)).toThrow();
    expect(() => parseSearxng({ results: {} }, 5)).toThrow();
    expect(parseSearxng({ results: [] }, 5)).toEqual([]);
  });
});
