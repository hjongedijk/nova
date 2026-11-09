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

/** Any program name, app-list name, document or path, as the Windows agent accepts it: no control characters. */
const app = {
  type: "string",
  minLength: 1,
  maxLength: 260,
  pattern:
    "^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$",
};

/**
 * Trim the name; a plain name (no path, drive or URI) is lower-cased so "Notepad" still hits the agent's app
 * list. Windows resolves program names case-insensitively, so this never changes which program opens.
 */
export function normalizeApp(value: unknown): string | null {
  const name = (typeof value === "string" ? value : "").trim();
  // eslint-disable-next-line no-control-regex -- the agent rejects control characters
  if (!name || name.length > 260 || /[\u0000-\u001f\u007f]/.test(name))
    return null;
  return /[\\/:]/.test(name) ? name : name.toLowerCase();
}

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
          "Open a program, document or folder on the user's Windows PC: a name from the PC's app list (windows_status shows them, for example notepad, calculator, explorer, terminal, chrome or vscode) or any program name, document or full path as given, for example Plex or C:\\Program Files\\App\\app.exe.",
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
          "Politely close all windows of a program on the Windows PC (a name from the app list or any process name such as notepad or Plex). Programs may still ask about unsaved work.",
        parameters: schema({ app }),
        risk: "SAFE",
      },
      {
        name: "windows_lock",
        description: "Lock the Windows PC screen.",
        parameters: schema(),
        risk: "SAFE",
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
    if (name === "windows_open_app" || name === "windows_close_app") {
      const target = normalizeApp(args.app);
      if (!target) return { ok: false, error: "Geef een programmanaam of pad" };
      return this.pc.call(name, { ...args, app: target }, signal);
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
