import { describe, expect, it } from "vitest";
import {
  pickVideo,
  spokenTitle,
  YoutubeService,
} from "../../src/integrations/youtube/youtube.service.js";

const video = (videoId: string, title: string, extra = {}) => ({
  videoRenderer: {
    videoId,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: "Kanaal" }] },
    lengthText: { simpleText: "3:07" },
    ...extra,
  },
});
const response = (...items: unknown[]) => ({
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [{ itemSectionRenderer: { contents: items } }],
        },
      },
    },
  },
});

describe("youtube", () => {
  it("the first real video is chosen: ads, live streams, premieres and malformed ids are skipped", () => {
    const picked = pickVideo(
      response(
        video("AAAAAAAAAAA", "Advertentie", { lengthText: undefined }),
        video("BBBBBBBBBBB", "Livestream", {
          badges: [{ metadataBadgeRenderer: { label: "LIVE" } }],
        }),
        video("CCCCCCCCCCC", "Straks", {
          upcomingEventData: { startTime: "1" },
        }),
        video("kort", "Ongeldig id"),
        { reelItemRenderer: { videoId: "SSSSSSSSSSS" } },
        video("DDDDDDDDDDD", "De juiste video"),
        video("EEEEEEEEEEE", "Een andere"),
      ),
    );
    expect(picked).toEqual({
      videoId: "DDDDDDDDDDD",
      title: "De juiste video",
      shortTitle: "De juiste video",
      channel: "Kanaal",
      duration: "3:07",
      url: "https://www.youtube.com/watch?v=DDDDDDDDDDD",
    });
    expect(
      pickVideo(
        response(video("AAAAAAAAAAA", "Ad", { lengthText: undefined })),
      ),
    ).toBeNull();
    expect(pickVideo({})).toBeNull();
    expect(pickVideo(null)).toBeNull();
  });

  it("a search for videos falls back to everything, then gives up cleanly", async () => {
    const youtube = new YoutubeService();
    const bodies: Record<string, unknown>[] = [];
    const found = await youtube.findVideo("kanaalnaam", {
      post: async (body) => {
        bodies.push(body);
        return body.params
          ? response()
          : response(video("FFFFFFFFFFF", "Via brede zoekactie"));
      },
    });
    expect(found?.videoId).toBe("FFFFFFFFFFF");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.params && !bodies[1]?.params).toBeTruthy();
    expect((bodies[0]?.context as { client: { hl: string } }).client.hl).toBe(
      "nl",
    );
    expect(
      await youtube.findVideo("niets", { post: async () => response() }),
    ).toBeNull();
    await expect(
      youtube.findVideo("x", {
        post: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow(/offline/);
  });

  it("long video titles are shortened to something that can be said", () => {
    expect(
      spokenTitle(
        "Relaxing Piano Music: Romantic Music, Beautiful Relaxing Music, Sleep Music, Stress Relief ★122",
      ),
    ).toBe("Relaxing Piano Music: Romantic Music, Beautiful Relaxing…");
    expect(
      spokenTitle("Yves Berendse - Terug In De Tijd (Officiële Video)"),
    ).toBe("Yves Berendse");
    expect(spokenTitle("Dit Is Echt Verdacht | MW4 [4K]")).toBe(
      "Dit Is Echt Verdacht",
    );
    expect(spokenTitle("Kort")).toBe("Kort");
    expect(spokenTitle("")).toBe("");
  });
});
