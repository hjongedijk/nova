import { IS_MOBILE } from "./device.ts";

/**
 * The controls (input, quick buttons, hints) tuck themselves away and come back on a move toward the
 * bottom, a touch or typing. `chrome.shown` drives the `chrome` class on <body>.
 */
export const chrome = $state({ shown: true });

let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** Something that keeps the controls up: a focused field, an open menu, a pending confirmation. */
let busy: () => boolean = () => false;
/** The pointer rests in the hot zone (bottom of the screen, top right corner). */
let zoneHot = false;

export function setChromeBusy(check: () => boolean): void {
  busy = check;
}

export function setChromeZone(hot: boolean): void {
  zoneHot = hot;
}

export function showChrome(holdMs = IS_MOBILE ? 9000 : 4500): void {
  chrome.shown = true;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(maybeHide, holdMs);
}

export function maybeHide(): void {
  clearTimeout(hideTimer);
  if (busy() || zoneHot) {
    hideTimer = setTimeout(maybeHide, 2000);
    return;
  }
  chrome.shown = false;
}
