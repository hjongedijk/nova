import { wallpaperMode } from "#lib/stores/device.ts";

/**
 * ?wallpaper=1 (+ &talk=1 &panels=0 &taskbarpx=N &bottom=N): NOVA as a desktop background.
 * Quiet wallpaper (no talk) shows only the living entity and the panels and never speaks.
 */
const mode = wallpaperMode();
export const wallpaper = mode.wallpaper;
export const quietWallpaper = mode.wallpaper && !mode.talk;

/**
 * As a desktop wallpaper the page only gets the clicks the Windows agent passes on, and the agent passes on
 * only clicks that land on something of the page. This tells it where those things are, in page pixels:
 * "x,y,w,h,t;..." where t=1 means typing goes there (fields, open windows).
 */
export function novaZones(): string {
  const zones: string[] = [];
  const add = (rect: DOMRect, typing: boolean) => {
    if (rect.width < 2 || rect.height < 2) return;
    zones.push(
      [rect.left, rect.top, rect.width, rect.height]
        .map((n) => Math.round(n))
        .concat(typing ? 1 : 0)
        .join(","),
    );
  };
  const shown = (el: Element) => {
    for (
      let node: Element | null = el;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      if (Number(style.opacity) < 0.05 && !node.matches(".composer"))
        return false;
    }
    return true;
  };
  // Open windows take the whole rectangle, and typing.
  for (const dialog of document.querySelectorAll("dialog[open], #history.open"))
    add(dialog.getBoundingClientRect(), true);
  const field = document.querySelector(".composer");
  if (field && shown(field)) add(field.getBoundingClientRect(), true);
  const core = document.getElementById("core");
  if (core) add(core.getBoundingClientRect(), false);
  for (const el of document.querySelectorAll(
    "button, a[href], input, textarea, select, [role=button], .toast, .dock-card",
  ))
    if (!el.closest("dialog, #history") && shown(el))
      add(el.getBoundingClientRect(), el.matches("input, textarea, select"));
  return zones.join(";");
}

/** Classes and the taskbar offset that wallpaper mode needs on <body>. Returns the cleanup. */
export function applyWallpaperMode(): () => void {
  const query = new URLSearchParams(location.search);
  (window as unknown as { __novaZones?: () => string }).__novaZones = novaZones;
  if (!wallpaper) return () => {};
  const classes = ["wallpaper"];
  // taskbarpx is the taskbar height in real pixels, sent by the Windows agent.
  const lift =
    Number(query.get("bottom")) ||
    (Number(query.get("taskbarpx")) > 0
      ? Number(query.get("taskbarpx")) / (window.devicePixelRatio || 1) + 24
      : 0);
  if (lift > 0 && lift <= 400)
    document.documentElement.style.setProperty("--taskbar", `${lift}px`);
  if (!quietWallpaper) classes.push("talk");
  if (query.get("panels") === "0") classes.push("nopanels");
  document.body.classList.add(...classes);
  return () => document.body.classList.remove(...classes);
}
