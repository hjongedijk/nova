import { Injectable } from "@nestjs/common";
import type {
  HelperMode,
  WallpaperDisplay,
  WallpaperMode,
  WindowsAgentStatus,
  WindowsHelperDebugStatus,
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
  windows_helper_debug: ["GET", "/v1/helper-debug"],
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

const RESULT_FIELDS: Record<string, readonly string[]> = {
  windows_status: [
    "hostname",
    "user",
    "uptimeHours",
    "features",
    "mode",
    "helperDisplay",
    "helperView",
    "helperWarnings",
    "agentPaused",
    "helperOpen",
    "agent",
    "apps",
    "running",
  ],
  windows_helper_debug: ["agent", "helper", "view", "display"],
  windows_open_app: [],
  windows_open_url: [],
  windows_close_app: ["closed"],
  windows_lock: [],
  windows_displays: ["displays", "mode", "helperDisplay", "helperView"],
  windows_wallpaper: ["displays", "mode", "helperDisplay", "helperView"],
  windows_mode: ["displays", "mode", "helperDisplay", "helperView"],
  windows_helper_preferences_get: ["preferences"],
  windows_helper_preferences_set: ["preferences"],
  windows_helper_notify: ["delivered", "reason", "seq"],
  windows_helper_size: ["expanded", "view", "hidden"],
};

const coordinate = "-?\\d{1,6}";
const rect = `(?:${coordinate},${coordinate},${coordinate},${coordinate}|n/a)`;
const fourPixels = "\\d{1,5},\\d{1,5},\\d{1,5},\\d{1,5}";
const helperDebugPattern = new RegExp(
  `^window=${rect} extended=${rect} monitor=${rect} work=${rect} shape=rectangle frame=${fourPixels} chrome=\\d{1,5},\\d{1,5} requested=${coordinate},${coordinate},\\d{1,5}x\\d{1,5} dpi=\\d{1,5} scale=\\d{1,3}(?:\\.\\d{1,4})? visible=(?:True|False) caption=(?:True|False) sizingFrame=(?:True|False) toolWindow=(?:True|False) appWindow=(?:True|False) topmost=(?:True|False)$`,
);

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

const controlsWarning =
  "Windows-bediening meldde een probleem. Controleer de agent op de pc.";
const safeWarnings = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? [controlsWarning] : [];
const safePreferences = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const hotkeys: Record<string, string> = {};
  if (
    source.hotkeys &&
    typeof source.hotkeys === "object" &&
    !Array.isArray(source.hotkeys)
  ) {
    const keys = source.hotkeys as Record<string, unknown>;
    for (const name of ["open", "speak", "mute", "desktop"]) {
      const key = keys[name];
      if (typeof key === "string" && /^[A-Za-z0-9+ -]{1,80}$/.test(key))
        hotkeys[name] = key;
    }
  }
  return {
    hotkeys,
    warnings: safeWarnings(source.warnings),
    ...(typeof source.paused === "boolean" ? { paused: source.paused } : {}),
    ...(typeof source.view === "string" && /^[a-z]{1,24}$/.test(source.view)
      ? { view: source.view }
      : {}),
    ...(typeof source.display === "number" &&
    Number.isInteger(source.display) &&
    source.display >= 0 &&
    source.display <= 8
      ? { display: source.display }
      : {}),
  };
};

/**
 * Talks to the Windows agent in agents/windows. The agent owns the allow-list of
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

  /** Small private settings status, with no host/user/process or upstream error details. */
  async settingsStatus(): Promise<WindowsAgentStatus> {
    const unavailable: WindowsAgentStatus = {
      available: false,
      version: null,
      helperOpen: null,
      paused: null,
      mode: null,
      display: null,
    };
    if (!this.configured)
      return { ...unavailable, error: "Er is geen Windows-agent ingesteld." };
    try {
      const outcome = await this.call(
        "windows_status",
        {},
        AbortSignal.timeout(6000),
      );
      if (!outcome.ok)
        return {
          ...unavailable,
          error:
            "De Windows-agent is niet bereikbaar of weigert de verbinding.",
        };
      const result = outcome.result;
      return {
        available: true,
        version:
          typeof result.agent === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(result.agent)
            ? result.agent
            : null,
        helperOpen:
          typeof result.helperOpen === "boolean" ? result.helperOpen : null,
        paused:
          typeof result.agentPaused === "boolean" ? result.agentPaused : null,
        mode:
          result.mode === "helper" ||
          result.mode === "wallpaper" ||
          result.mode === "both"
            ? result.mode
            : null,
        display:
          typeof result.helperDisplay === "number" &&
          Number.isInteger(result.helperDisplay) &&
          result.helperDisplay >= 0 &&
          result.helperDisplay <= 8
            ? result.helperDisplay
            : null,
      };
    } catch {
      return {
        ...unavailable,
        error:
          "De Windows-agent antwoordt nu niet. Controleer of de pc aanstaat.",
      };
    }
  }

  /** Return bounded, non-secret measurements for the currently open helper window. */
  async helperDebug(): Promise<WindowsHelperDebugStatus> {
    const unavailable: WindowsHelperDebugStatus = {
      available: false,
      helper: null,
      view: null,
      display: null,
      checkedAt: null,
    };
    if (!this.configured)
      return { ...unavailable, error: "Er is geen Windows-agent ingesteld." };
    try {
      const outcome = await this.call(
        "windows_helper_debug",
        {},
        AbortSignal.timeout(6000),
      );
      if (!outcome.ok)
        return {
          ...unavailable,
          error: "De meting van de Windows-helper is niet beschikbaar.",
        };
      const helper = outcome.result.helper;
      if (
        typeof helper !== "string" ||
        helper.length > 1000 ||
        !helperDebugPattern.test(helper)
      )
        return {
          ...unavailable,
          error:
            "De Windows-agent gaf geen geldige helpermeting terug. Werk de agent bij.",
        };
      const display = outcome.result.display;
      return {
        available: true,
        helper,
        view:
          typeof outcome.result.view === "string" &&
          /^[a-z]{1,24}$/.test(outcome.result.view)
            ? outcome.result.view
            : null,
        display:
          typeof display === "number" &&
          Number.isInteger(display) &&
          display >= 0 &&
          display <= 8
            ? display
            : null,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        ...unavailable,
        error:
          "De Windows-agent antwoordt nu niet. Controleer of de pc aanstaat en de helper open is.",
      };
    }
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
          "De Windows-agent op je pc is nog oud. Werk nova-agent.ps1 bij en start NOVAAgent opnieuw in Taakplanner.",
      };
    if (response.status !== 200 || response.data?.ok !== true)
      return {
        ok: false,
        error:
          "De Windows-agent reageert niet zoals verwacht. Controleer de verbinding en probeer opnieuw.",
      };
    const result: Record<string, unknown> = { ok: true };
    for (const key of RESULT_FIELDS[name] ?? []) {
      if (response.data[key] !== undefined) result[key] = response.data[key];
    }
    if (name === "windows_status")
      result.helperWarnings = safeWarnings(result.helperWarnings);
    if (
      name === "windows_helper_preferences_get" ||
      name === "windows_helper_preferences_set"
    )
      result.preferences = safePreferences(result.preferences);
    if (name === "windows_helper_notify") {
      if (typeof result.delivered !== "boolean") delete result.delivered;
      if (result.reason !== "paused" && result.reason !== "helper-disabled")
        delete result.reason;
      if (
        typeof result.seq !== "number" ||
        !Number.isSafeInteger(result.seq) ||
        result.seq <= 0
      )
        delete result.seq;
    }
    return { ok: true, verified: null, result };
  }
}
