import { afterEach, describe, expect, it } from "vitest";
import type { YoutubeVideo } from "@nova/contracts";
import { WindowsPcService } from "../../src/integrations/windows/windows-pc.service.js";
import { WindowsTools } from "../../src/integrations/windows/windows.tools.js";
import { YoutubeService } from "../../src/integrations/youtube/youtube.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

async function agent(
  token = "agent-token",
  handler?: Parameters<typeof listen>[0],
  publicUrl = "",
) {
  const fake = await listen(
    handler ??
      ((seen, send) => {
        if (seen.headers.authorization !== "Bearer agent-token")
          return send(401, { ok: false, error: "Unauthorized" });
        send(200, { ok: true, apps: ["notepad"], displays: [] });
      }),
  );
  closers.push(fake.close);
  const pc = new WindowsPcService(
    fakeConfig({ windowsAgent: { url: fake.url, token }, publicUrl }),
  );
  const youtube = new YoutubeService();
  return { fake, pc, youtube, tools: new WindowsTools(pc, youtube) };
}

describe("Windows tools", () => {
  it("calls are authenticated and unconfigured clients stay disabled", async () => {
    const off = new WindowsPcService(
      fakeConfig({ windowsAgent: { url: "", token: "" } }),
    );
    expect(off.configured).toBe(false);
    expect(
      new WindowsTools(off, new YoutubeService())
        .definitions()
        .every((tool) => tool.enabled === false),
    ).toBe(true);
    const { fake, pc, tools } = await agent();
    expect(pc.configured).toBe(true);
    const open = await tools.execute(
      "windows_open_app",
      { app: "notepad" },
      call(),
    );
    expect(open.ok).toBe(true);
    expect(fake.requests.at(-1)?.url).toBe("/v1/open-app");
    expect(JSON.parse(fake.requests.at(-1)!.body).app).toBe("notepad");
    const wrong = await agent("wrong", undefined);
    const bad = await wrong.tools.execute("windows_status", {}, call());
    expect([bad.ok, bad.error]).toEqual([false, "Unauthorized"]);
    const risks = Object.fromEntries(
      tools.definitions().map((item) => [item.name, item.risk]),
    );
    expect(risks.windows_open_app).toBe("SAFE");
    expect(risks.windows_close_app).toBe("CONFIRM");
    expect(risks.windows_lock).toBe("CONFIRM");
    expect(Object.keys(risks)).toHaveLength(9);
  });

  it("windows_search opens the results page in the default browser, with the query encoded", async () => {
    const { fake, tools } = await agent("agent-token", (_seen, send) =>
      send(200, { ok: true, opened: true }),
    );
    const out = await tools.execute(
      "windows_search",
      { query: "auto's & fietsen", engine: "youtube" },
      call(),
    );
    expect(out.ok).toBe(true);
    expect(fake.requests[0]?.url).toBe("/v1/open-url");
    expect(JSON.parse(fake.requests[0]!.body).url).toBe(
      "https://www.youtube.com/results?search_query=auto's%20%26%20fietsen",
    );
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer agent-token");
    await tools.execute("windows_search", { query: "weer" }, call());
    expect(JSON.parse(fake.requests[1]!.body).url).toBe(
      "https://www.google.com/search?q=weer",
    );
    expect(
      (
        await tools.execute(
          "windows_search",
          { query: "x", engine: "nope" },
          call(),
        )
      ).ok,
    ).toBe(false);
  });

  const found: YoutubeVideo = {
    videoId: "ERSCR2cuqAU",
    title: "Terug In De Tijd",
    shortTitle: "Terug In De Tijd",
    channel: "Dino Music",
    duration: "3:07",
    url: "https://www.youtube.com/watch?v=ERSCR2cuqAU",
  };

  it("windows_play_youtube opens the video itself, with autoplay, and says which one", async () => {
    const { fake, tools, youtube } = await agent("agent-token", (_s, send) =>
      send(200, { ok: true }),
    );
    youtube.findVideo = async () => found;
    const out = await tools.execute(
      "windows_play_youtube",
      { query: "terug in de tijd" },
      call(),
    );
    expect(out.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe("/v1/open-url");
    expect(JSON.parse(fake.requests[0]!.body).url).toBe(
      "https://www.youtube.com/watch?v=ERSCR2cuqAU&autoplay=1",
    );
    const result = out.result as { video: YoutubeVideo; hint: string };
    expect(result.video.title).toBe("Terug In De Tijd");
    expect(result.video.channel).toBe("Dino Music");
    expect(result.hint).toMatch(/shortTitle/);
  });

  it("when no video is found, or YouTube is unreachable, the results page opens instead and it says so", async () => {
    for (const finder of [
      async () => null,
      async (): Promise<YoutubeVideo> => {
        throw new Error("offline");
      },
    ]) {
      const { fake, tools, youtube } = await agent("agent-token", (_s, send) =>
        send(200, { ok: true }),
      );
      youtube.findVideo = finder;
      const out = await tools.execute(
        "windows_play_youtube",
        { query: "iets & zo" },
        call(),
      );
      const result = out.result as { fallback: string; note: string };
      expect(out.ok).toBe(true);
      expect(result.fallback).toBe("search");
      expect(result.note).toMatch(/zoekresultaten/);
      expect(JSON.parse(fake.requests[0]!.body).url).toBe(
        "https://www.youtube.com/results?search_query=iets%20%26%20zo",
      );
    }
  });

  it("a Windows agent error is passed on", async () => {
    const pc = new WindowsPcService(
      fakeConfig({ windowsAgent: { url: "http://127.0.0.1:1", token: "t" } }),
    );
    const youtube = new YoutubeService();
    youtube.findVideo = async () => found;
    await expect(
      new WindowsTools(pc, youtube).execute(
        "windows_play_youtube",
        { query: "x" },
        call(),
      ),
    ).rejects.toThrow();
  });
});

describe("WindowsPcService displays and wallpaper", () => {
  const displays = [
    {
      index: 1,
      name: "D1",
      primary: true,
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      mode: "off",
    },
  ];

  it("lists displays and sends the wallpaper request with the public origin", async () => {
    const { fake, pc } = await agent(
      "agent-token",
      (_s, send) => send(200, { ok: true, displays }),
      "https://nova.example.com/some/path",
    );
    const list = await pc.displays();
    expect(list).toEqual({
      ok: true,
      verified: null,
      result: { ok: true, displays },
    });
    expect(fake.requests[0]?.method).toBe("GET");
    const set = await pc.setWallpaper(2, "sphere");
    expect(set.ok).toBe(true);
    expect(fake.requests[1]?.url).toBe("/v1/wallpaper");
    expect(JSON.parse(fake.requests[1]!.body)).toEqual({
      display: 2,
      mode: "sphere",
      url: "https://nova.example.com",
    });
  });

  it("sends no url when NOVA_PUBLIC_URL is unset, and says the agent is old on a 404", async () => {
    const { fake, pc } = await agent("agent-token", (_s, send) =>
      send(404, {}),
    );
    const out = await pc.setWallpaper(0, "off");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/nog oud/);
    expect(JSON.parse(fake.requests[0]!.body)).toEqual({
      display: 0,
      mode: "off",
    });
    expect((await pc.displays()).ok).toBe(false);
  });
});
