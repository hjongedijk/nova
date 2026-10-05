import type { WallpaperDisplay, WallpaperMode } from "@nova/contracts";

export type WallpaperOutcome =
  { ok: true; displays: WallpaperDisplay[] } | { ok: false; error: string };

/**
 * The wallpaper on the Windows PC, through the Windows agent. The Windows integration module
 * provides it under WALLPAPER_PORT; without it the settings screen says there is no agent.
 */
export interface WallpaperPort {
  /** False when no Windows agent is set up. */
  readonly configured: boolean;
  displays(): Promise<WallpaperOutcome>;
  /** display 0 means all displays. */
  setWallpaper(display: number, mode: WallpaperMode): Promise<WallpaperOutcome>;
}

export const WALLPAPER_PORT = Symbol("nova:wallpaper-port");
