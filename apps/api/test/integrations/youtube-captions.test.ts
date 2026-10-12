import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionTracks,
  chooseCaptionTrack,
  parseCaptionVtt,
  youtubeVideoId,
} from "../../src/integrations/youtube/youtube-captions.js";
import { YoutubeCaptionsSource } from "../../src/integrations/youtube/youtube-captions.source.js";
import type { YoutubeOAuthService } from "../../src/integrations/youtube/youtube-oauth.service.js";

afterEach(() => vi.unstubAllGlobals());

const source = (connected = true) =>
  new YoutubeCaptionsSource({
    status: () => ({ connected }),
    getAccessToken: async () => (connected ? "private-token" : null),
  } as YoutubeOAuthService);
const call = { sessionId: "test", signal: new AbortController().signal };
const videoId = "AbC_123-xYz";
const list = (items: unknown[]) =>
  new Response(JSON.stringify({ items }), {
    headers: { "content-type": "application/json" },
  });
const track = (id: string, language: string, trackKind = "standard") => ({
  id,
  snippet: { language, name: language, trackKind },
});

describe("YouTube caption parsing", () => {
  it("accepts a video ID and standard YouTube URLs only", () => {
    expect(youtubeVideoId(videoId)).toBe(videoId);
    expect(
      youtubeVideoId(`https://www.youtube.com/watch?v=${videoId}&t=9`),
    ).toBe(videoId);
    expect(youtubeVideoId(`https://youtu.be/${videoId}`)).toBe(videoId);
    expect(youtubeVideoId(`https://m.youtube.com/shorts/${videoId}`)).toBe(
      videoId,
    );
    for (const bad of [
      `https://youtube.com.evil.test/watch?v=${videoId}`,
      `https://www.youtube.com/watch?v=${videoId}&v=${videoId}`,
      `https://www.youtube.com/@channel`,
      `http://youtu.be/${videoId}`,
      "not-an-id",
    ])
      expect(youtubeVideoId(bad)).toBeNull();
  });

  it("selects an exact language and prefers normal tracks over automatic tracks", () => {
    const tracks = captionTracks({
      items: [
        track("auto", "nl", "ASR"),
        track("manual", "nl"),
        track("en", "en"),
        { id: "broken", snippet: { language: "bad language" } },
      ],
    });
    expect(tracks).toHaveLength(3);
    expect(chooseCaptionTrack(tracks)?.id).toBe("manual");
    expect(chooseCaptionTrack(tracks, "en")?.id).toBe("en");
    expect(chooseCaptionTrack(tracks, "fr")).toBeNull();
  });

  it("extracts cue text, strips VTT markup, and bounds returned characters", () => {
    const parsed = parseCaptionVtt(
      "WEBVTT\n\nNOTE ignore me\n\n1\n00:00:01.000 --> 00:00:02.000\n<c.red>Hello</c> &amp; world\n\n" +
        "00:00:03.000 --> 00:00:04.000 align:start\nsecond cue",
    );
    expect(parsed).toEqual({
      text: "Hello & world\nsecond cue",
      cueCount: 2,
      truncated: false,
    });
    expect(
      parseCaptionVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nabcdef", 3),
    ).toEqual({ text: "abc", cueCount: 1, truncated: true });
  });
});

describe("YouTube captions tool", () => {
  it("reads only official caption endpoints and returns transcript as untrusted data", async () => {
    const fetcher = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer private-token",
      );
      if (url.pathname === "/youtube/v3/captions") {
        expect(url.searchParams.get("part")).toBe("snippet");
        expect(url.searchParams.get("videoId")).toBe(videoId);
        return list([track("caption-id", "nl")]);
      }
      expect(url.pathname).toBe("/youtube/v3/captions/caption-id");
      expect(url.searchParams.get("tfmt")).toBe("vtt");
      return new Response(
        "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVideo text",
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await source().execute(
      "youtube_captions",
      { video: videoId },
      call,
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        videoId,
        language: "nl",
        text: "Video text",
        untrusted: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stays disabled without a connection and never calls Google", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const tool = source(false);
    expect(tool.definitions()[0]?.enabled).toBe(false);
    expect(
      await tool.execute("youtube_captions", { video: videoId }, call),
    ).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns generic errors for no captions, permission, and quota responses", async () => {
    for (const response of [
      list([]),
      new Response("private upstream text", { status: 403 }),
      new Response("quota details", { status: 429 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      const result = await source().execute(
        "youtube_captions",
        { video: videoId },
        call,
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(
        /private upstream text|quota details|private-token/,
      );
    }
  });

  it("rejects an oversized VTT body without returning its content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(list([track("caption-id", "nl")]))
        .mockResolvedValueOnce(new Response("x".repeat(512_001))),
    );
    const result = await source().execute(
      "youtube_captions",
      { video: videoId },
      call,
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("xxxx");
  });
});
