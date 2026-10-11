import { describe, expect, it } from "vitest";
import {
  newsHeadlines,
  parseNewsFeeds,
  type ConfiguredNewsFeed,
} from "../../src/integrations/world/news.js";
import type { WorldHttp } from "../../src/integrations/world/world.types.js";

describe("configured RSS news", () => {
  it("accepts only a bounded list of named HTTP(S) feeds without credentials", () => {
    expect(
      parseNewsFeeds(
        JSON.stringify([
          { name: "  NOS ", url: "https://feeds.example/news" },
          { name: "Bad", url: "https://user:pass@example.test/rss" },
          { name: "File", url: "file:///etc/passwd" },
          null,
        ]),
      ),
    ).toEqual([{ name: "NOS", url: "https://feeds.example/news" }]);
    expect(parseNewsFeeds("not json")).toEqual([]);
    expect(
      parseNewsFeeds(
        JSON.stringify(
          Array(6).fill({
            name: "Feed",
            url: "https://feeds.example/rss",
          }),
        ),
      ),
    ).toHaveLength(5);
  });

  it("summarizes configured public feeds and keeps source labels with each item", async () => {
    const calls: { url: string; maxBytes?: number; timeoutMs?: number }[] = [];
    const http = {
      getPage: async (
        url: string,
        options?: { maxBytes?: number; timeoutMs?: number },
      ) => {
        calls.push({
          url,
          maxBytes: options?.maxBytes,
          timeoutMs: options?.timeoutMs,
        });
        if (url.includes("broken")) throw new Error("unavailable");
        return {
          status: 200,
          headers: {},
          url,
          body: `<rss><item><title>Nieuws van ${url}</title><description><![CDATA[Eerste zin. Tweede zin.]]></description><link>${url}</link></item></rss>`,
        };
      },
    } as unknown as WorldHttp;
    const feeds: ConfiguredNewsFeed[] = [
      { name: "Mijn bron", url: "https://feeds.example/news" },
      { name: "Niet bereikbaar", url: "https://feeds.example/broken" },
    ];
    const result = await newsHeadlines(http, "tech", 4, undefined, feeds);
    expect(result).toMatchObject({
      source: "jouw RSS-bronnen",
      topic: "algemeen",
    });
    expect(result?.items).toEqual([
      expect.objectContaining({ source: "Mijn bron", summary: "Eerste zin." }),
    ]);
    expect(calls[0]).toMatchObject({ maxBytes: 500_000, timeoutMs: 7000 });
  });
});
