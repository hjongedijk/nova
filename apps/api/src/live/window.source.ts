import type { NovaWindowEvent } from "@nova/contracts";
import { WorldService } from "../integrations/world/world.service.js";
import {
  schema,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { previewText } from "../chat/tool-preview.js";
import { safeHttpUrl, videoSource, windowId } from "./window-media.js";

/*
 * window_open: NOVA opens a floating window on the owner's screen by itself: a video ("speel X af"), a web page,
 * an image or a document. Display only: nothing runs on the PC and nothing is fetched by the server except the
 * video search. No confirmation (owner decision: full autonomy).
 */
const KINDS = ["video", "page", "image", "document"] as const;

@ToolSourceProvider()
export class WindowSource implements ToolSource {
  readonly source = "windows-ui";
  constructor(private readonly world: WorldService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "window_open",
        description:
          "Open a floating window on the user's NOVA screen (browser app or wallpaper) and show something in it: kind video plays a video (YouTube, Vimeo, an mp4/webm file or an HLS .m3u8 stream) with play, pause and close; page shows a web page; image an image; document a PDF or text file. Use it when the user says 'speel X af', 'laat X zien', 'toon de video', 'open die pagina hier'. For a video you do not have the address of, pass query and NOVA finds it (YouTube first). Several windows can be open at once. Not for the PC's own browser: that is browser_open.",
        parameters: schema(
          {
            kind: { type: "string", enum: [...KINDS] },
            url: {
              type: "string",
              minLength: 8,
              maxLength: 2000,
              pattern: "^https?://\\S+$",
            },
            query: { type: "string", minLength: 1, maxLength: 200 },
            title: { type: "string", minLength: 1, maxLength: 160 },
          },
          ["kind"],
        ),
        risk: "SAFE",
        timeoutMs: 20000,
        enabled: true,
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call?: ToolCall,
  ): Promise<ToolResult> {
    if (name !== "window_open") return { ok: false, error: "Unknown tool" };
    const kind = args.kind as (typeof KINDS)[number];
    const title = previewText(args.title, 160);
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let url = safeHttpUrl(args.url);
    if (kind === "video") {
      let found = url ? videoSource(url) : null;
      let foundTitle = title;
      if (!found && typeof args.query === "string" && args.query.trim()) {
        let results: { title: string; url: string }[];
        try {
          results = await this.world.searchVideos(args.query, call?.signal);
        } catch {
          return {
            ok: false,
            error: "Zoeken naar die video lukte niet. Probeer het zo nog eens.",
          };
        }
        // YouTube first: it plays everywhere without a login.
        const playable = results
          .map((result) => ({ result, source: videoSource(result.url) }))
          .filter((entry) => entry.source)
          .sort(
            (a, b) =>
              Number(b.source!.provider === "youtube") -
              Number(a.source!.provider === "youtube"),
          );
        const best = playable[0];
        if (best) {
          found = best.source;
          url = safeHttpUrl(best.result.url);
          foundTitle = title || previewText(best.result.title, 160);
        }
      }
      if (!found)
        return {
          ok: false,
          error: url
            ? "Dat adres is geen video die NOVA kan afspelen (YouTube, Vimeo, mp4/webm of HLS)."
            : "Geen afspeelbare video gevonden. Geef een adres of een andere zoekterm.",
        };
      const window: NovaWindowEvent = {
        id: windowId("video", seed),
        kind: "video",
        title: foundTitle || "Video",
        video: found,
        ...(url ? { url } : {}),
      };
      return {
        ok: true,
        verified: null,
        window,
        result: {
          opened: "video",
          title: window.title,
          provider: found.provider,
          ...(url ? { url } : {}),
        },
      };
    }
    if (!url)
      return { ok: false, error: "Geef een http- of https-adres om te tonen." };
    const window: NovaWindowEvent = {
      id: windowId(kind, seed),
      kind,
      title: title || new URL(url).hostname.replace(/^www\./, ""),
      url,
      result: kind === "page",
    };
    return {
      ok: true,
      verified: null,
      window,
      result: { opened: kind, title: window.title, url },
    };
  }
}
