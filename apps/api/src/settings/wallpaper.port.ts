import type {
  HelperMode,
  WallpaperDisplay,
  WallpaperMode,
} from "@nova/contracts";

export type WallpaperOutcome =
  | {
      ok: true;
      displays: WallpaperDisplay[];
      /** What the agent runs now; absent on an agent without the helper. */
      mode?: HelperMode;
      helperDisplay?: number;
    }
  | { ok: false; error: string };

/**
 * The desktop on the Windows PC (wallpaper and the helper overlay), through the Windows agent. The
 * Windows integration module provides it under WALLPAPER_PORT; without it the settings screen says
 * there is no agent.
 */
export interface WallpaperPort {
  helperPreferences?(hotkeys?: Record<string, string>): Promise<{
    ok: boolean;
    preferences?: {
      hotkeys: Record<string, string>;
      warnings: string[];
      paused: boolean;
    };
    error?: string;
  }>;
  /** False when no Windows agent is set up. */
  readonly configured: boolean;
  displays(): Promise<WallpaperOutcome>;
  /** display 0 means all displays. */
  setWallpaper(display: number, mode: WallpaperMode): Promise<WallpaperOutcome>;
  /** Switch between wallpaper, helper and both; display is the helper's display (0 = primary). */
  setMode(mode: HelperMode, display: number): Promise<WallpaperOutcome>;
  /** The helper window grows (an answer, a question) or shrinks back to its pill. */
  helperSize(
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
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export const WALLPAPER_PORT = Symbol("nova:wallpaper-port");
