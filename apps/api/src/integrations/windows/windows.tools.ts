import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../../tools/tool.types.js";
import { YoutubeService } from "../youtube/youtube.service.js";
import { SEARCH_ENGINES, WindowsPcService } from "./windows-pc.service.js";

const app = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9-]+$",
};

@ToolSourceProvider()
export class WindowsTools implements ToolSource {
  readonly source = "windows";
  constructor(
    private readonly pc: WindowsPcService,
    private readonly youtube: YoutubeService,
  ) {}

  definitions(): ToolDefinition[] {
    const enabled = this.pc.configured;
    const defs: Omit<ToolDefinition, "enabled">[] = [
      {
        name: "windows_status",
        description:
          "Read the Windows PC status: hostname, user, uptime, the apps NOVA may open and which are running.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "windows_open_app",
        description:
          "Open an allow-listed program on the user's Windows PC, for example notepad, calculator, paint, explorer, task-manager, settings, terminal, edge, chrome or vscode. Call windows_status to see the exact allowed names.",
        parameters: schema({ app }),
        risk: "SAFE",
      },
      {
        name: "windows_open_url",
        description:
          "Open an http(s) URL in the default browser on the Windows PC.",
        parameters: schema({
          url: {
            type: "string",
            minLength: 8,
            maxLength: 2000,
            pattern: "^https?://\\S+$",
          },
        }),
        risk: "SAFE",
      },
      {
        name: "windows_play_youtube",
        description:
          "Start a video on YouTube on the user's Windows PC: finds the first real video for the search and opens it so it plays. Use it for 'speel X op YouTube', 'zet X op YouTube aan' and 'play X'. For 'zoek X op YouTube' (only show results) use windows_search instead. Say which video it is, from the result.",
        parameters: schema({ query: text(200) }, ["query"]),
        risk: "SAFE",
      },
      {
        name: "windows_search",
        description:
          "Open a web search for the user in the default browser on the Windows PC, for 'zoek me X op' when browser_* tools are not available. engine is google (default), duckduckgo, bing, youtube, wikipedia, maps, amazon or bol. It only opens the results; it cannot read them.",
        parameters: schema(
          {
            query: text(300),
            engine: { type: "string", enum: Object.keys(SEARCH_ENGINES) },
          },
          ["query"],
        ),
        risk: "SAFE",
      },
      {
        name: "windows_displays",
        description:
          "List the displays (monitors) of the Windows PC with their number, size, whether it is the main one, and whether NOVA is set as living wallpaper on it.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "windows_wallpaper",
        description:
          "Show NOVA as a living wallpaper behind the desktop icons of the Windows PC, on one display or all. display is the display number from windows_displays (0 = all displays). mode is full (sphere and panels), sphere (only the sphere) or off (remove it again). The normal wallpaper setting is not changed.",
        parameters: schema({
          display: integer(0, 8),
          mode: { type: "string", enum: ["full", "sphere", "off"] },
        }),
        risk: "SAFE",
      },
      {
        name: "windows_close_app",
        description:
          "Politely close all windows of an allow-listed program on the Windows PC. Unsaved work may be lost; requires confirmation.",
        parameters: schema({ app }),
        risk: "CONFIRM",
      },
      {
        name: "windows_lock",
        description: "Lock the Windows PC screen. Requires confirmation.",
        parameters: schema(),
        risk: "CONFIRM",
      },
    ];
    return defs.map((def) => ({ ...def, enabled }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call?: ToolCall,
  ): Promise<ToolResult> {
    const signal = call?.signal;
    if (name === "windows_play_youtube")
      return this.play(String(args.query), signal);
    if (name === "windows_search") {
      const base = SEARCH_ENGINES[String(args.engine || "google")];
      if (!base) return { ok: false, error: "Unknown search engine" };
      return this.pc.call(
        "windows_open_url",
        { url: base + encodeURIComponent(String(args.query).trim()) },
        signal,
      );
    }
    return this.pc.call(name, args, signal);
  }

  private async play(query: string, signal?: AbortSignal): Promise<ToolResult> {
    let video;
    try {
      video = await this.youtube.findVideo(query, { signal });
    } catch {
      video = null;
    }
    if (!video) {
      const opened = await this.execute(
        "windows_search",
        { query, engine: "youtube" },
        signal ? { sessionId: "", signal } : undefined,
      );
      return opened.ok
        ? {
            ...opened,
            result: {
              ...(opened.result as object),
              fallback: "search",
              note: "Ik vond geen video om direct af te spelen, dus de zoekresultaten staan open.",
            },
          }
        : opened;
    }
    const opened = await this.pc.call(
      "windows_open_url",
      { url: `${video.url}&autoplay=1` },
      signal,
    );
    return opened.ok
      ? {
          ...opened,
          result: {
            ...opened.result,
            video: {
              title: video.title,
              shortTitle: video.shortTitle,
              channel: video.channel,
              duration: video.duration,
              url: video.url,
            },
            hint: "Zeg welke video er opstaat met shortTitle en het kanaal, kort. Je kunt niet zien of hij echt speelt.",
          },
        }
      : opened;
  }
}
