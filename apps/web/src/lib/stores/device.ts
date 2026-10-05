const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const IS_IOS =
  /iPhone|iPad|iPod/.test(agent) ||
  (typeof navigator !== "undefined" &&
    navigator.platform === "MacIntel" &&
    navigator.maxTouchPoints > 1);
export const IS_MOBILE = IS_IOS || /Android/i.test(agent);

/** ?wallpaper=1 (+ &talk=1 &panels=0 &taskbarpx=N &bottom=N): NOVA as a desktop background. */
export function wallpaperMode() {
  const query = new URLSearchParams(
    typeof location === "undefined" ? "" : location.search,
  );
  const wallpaper = Boolean(query.get("wallpaper"));
  return {
    wallpaper,
    talk: wallpaper && query.get("talk") === "1",
    panels: query.get("panels") !== "0",
    taskbarPx: Number(query.get("taskbarpx")) || 0,
    bottom: Number(query.get("bottom")) || 0,
  };
}
