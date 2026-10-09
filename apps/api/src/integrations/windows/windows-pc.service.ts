import { Injectable } from "@nestjs/common";
import type {
  HelperMode,
  WallpaperDisplay,
  WallpaperMode,
} from "@nova/contracts";
import { NovaConfig } from "../../core/config/nova-config.js";
import { requestJson } from "../../core/http/http-json.js";
import { publicOrigin } from "../../core/public-url.js";

export const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
  youtube: "https://www.youtube.com/results?search_query=",
  wikipedia: "https://nl.wikipedia.org/w/index.php?search=",
  maps: "https://www.google.com/maps/search/",
  amazon: "https://www.amazon.nl/s?k=",
  bol: "https://www.bol.com/nl/nl/s/?searchtext=",
};

/** What a call to the Windows agent comes to. */
export type AgentOutcome<T = Record<string, unknown>> =
  { ok: true; verified: null; result: T } | { ok: false; error: string };

const ROUTES: Record<string, ["GET" | "POST", string]> = {
  windows_status: ["GET", "/v1/status"],
  windows_open_app: ["POST", "/v1/open-app"],
  windows_open_url: ["POST", "/v1/open-url"],
  windows_close_app: ["POST", "/v1/close-app"],
  windows_lock: ["POST", "/v1/lock"],
  windows_displays: ["GET", "/v1/displays"],
  windows_wallpaper: ["POST", "/v1/wallpaper"],
  windows_mode: ["POST", "/v1/mode"],
  windows_helper_preferences_get: ["GET", "/v1/helper/preferences"],
  windows_helper_preferences_set: ["POST", "/v1/helper/preferences"],
  windows_helper_notify: ["POST", "/v1/helper/notify"],
  windows_helper_size: ["POST", "/v1/helper/size"],
};

/** The displays plus what the agent runs (wallpaper, helper or both). */
export interface DesktopState {
  displays: WallpaperDisplay[];
  mode?: HelperMode;
  helperDisplay?: number;
}

interface AgentBody {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Talks to the Windows agent in integrations/windows-agent. The agent owns the allow-list of
 * programs; NOVA only ever sends an app name or an http(s) URL.
 */
@Injectable()
export class WindowsPcService {
  constructor(private readonly config: NovaConfig) {}

  private get url() {
    return this.config.windowsAgent.url;
  }
  private get token() {
    return this.config.windowsAgent.token;
  }
  get configured(): boolean {
    return Boolean(this.url && this.token);
  }
  health() {
    return {
      configured: this.configured,
      url: this.configured ? this.url : null,
    };
  }

  /** The displays with their wallpaper mode. */
  async displays(signal?: AbortSignal): Promise<AgentOutcome<DesktopState>> {
    return (await this.call(
      "windows_displays",
      {},
      signal,
    )) as AgentOutcome<DesktopState>;
  }

  /** Show NOVA as living wallpaper on one display (0 = all) or take it off again. */
  async setWallpaper(
    display: number,
    mode: WallpaperMode,
    signal?: AbortSignal,
  ): Promise<AgentOutcome<DesktopState>> {
    return (await this.call(
      "windows_wallpaper",
      { display, mode },
      signal,
    )) as AgentOutcome<DesktopState>;
  }

  /** Wallpaper, helper overlay or both; display is the helper's display (0 = primary). */
  async setMode(
    mode: HelperMode,
    display: number,
    signal?: AbortSignal,
  ): Promise<AgentOutcome<DesktopState>> {
    return (await this.call(
      "windows_mode",
      { mode, display },
      signal,
    )) as AgentOutcome<DesktopState>;
  }

  async helperPreferences(
    hotkeys?: Record<string, string>,
  ): Promise<AgentOutcome> {
    return this.call(
      hotkeys
        ? "windows_helper_preferences_set"
        : "windows_helper_preferences_get",
      hotkeys ? { hotkeys } : {},
    );
  }
  async notifyHelper(
    event: import("@nova/contracts").FeedEvent,
  ): Promise<AgentOutcome> {
    return this.call("windows_helper_notify", { event });
  }

  /** Grow or shrink the helper window (the helper page asks for it). */
  async helperSize(
    expanded: boolean,
    options?: {
      view:
        | "compact"
        | "overview"
        | "chat"
        | "weather"
        | "lists"
        | "notifications"
        | "confirmation";
      hidden: boolean;
      reducedMotion: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AgentOutcome> {
    return this.call("windows_helper_size", { expanded, ...options }, signal);
  }

  /** Runs one of the agent's own tools (everything except search and YouTube, which build on it). */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentOutcome> {
    const route = ROUTES[name];
    if (!route) return { ok: false, error: "Unknown Windows tool" };
    // These open or close windows on the PC, which takes a few seconds.
    const wallpaper = name === "windows_wallpaper" || name === "windows_mode";
    const openingHelper =
      name === "windows_helper_notify" || name === "windows_helper_size";
    const origin = publicOrigin(this.config.publicUrl);
    const response = await requestJson<AgentBody>(this.url + route[1], {
      method: route[0],
      headers: { authorization: `Bearer ${this.token}` },
      body: wallpaper
        ? { ...args, ...(origin ? { url: origin } : {}) }
        : route[0] === "POST"
          ? args
          : undefined,
      // Opening the wallpaper window takes a few seconds.
      timeoutMs: openingHelper ? 45000 : 15000,
      signal:
        wallpaper || openingHelper
          ? AbortSignal.any(
              [signal, AbortSignal.timeout(45000)].filter(
                (item): item is AbortSignal => Boolean(item),
              ),
            )
          : signal,
    });
    if (
      response.status === 404 &&
      /displays|wallpaper|mode|helper/.test(route[1])
    )
      return {
        ok: false,
        error:
          "De Windows-agent op je pc is nog oud. Werk jarvis-agent.ps1 bij en start de taak JarvisAgent opnieuw.",
      };
    if (response.status !== 200 || response.data?.ok !== true)
      return {
        ok: false,
        error:
          response.data?.error || `Windows agent error (${response.status})`,
      };
    return { ok: true, verified: null, result: response.data };
  }
}
