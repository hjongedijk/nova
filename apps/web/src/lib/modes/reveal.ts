import {
  chrome,
  setChromeZone,
  showChrome,
} from "#lib/stores/chrome.svelte.ts";

/**
 * The quiet interface: the controls tuck themselves away and come back when you reach for them.
 * - A touch has no hover: any tap on the page brings the controls up, and only that. The tap that reveals
 *   them never presses one of them, even though they appear under the finger.
 * - A move toward the bottom (or the top right corner) brings them up and holds them while you stay there.
 * - Typing a character anywhere focuses the input.
 * Returns the cleanup.
 */
export function installReveal(
  input: () => HTMLInputElement | null,
): () => void {
  let revealedByTouch = 0;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    if (!chrome.shown) revealedByTouch = Date.now();
    showChrome();
  };
  const onClickCapture = (event: MouseEvent) => {
    if (
      Date.now() - revealedByTouch < 700 &&
      (event.target as Element | null)?.closest?.(
        ".chips, .composer, #voiceHint",
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const hot =
      event.clientY > innerHeight - 230 ||
      (event.clientY < 90 && event.clientX > innerWidth - 280);
    setChromeZone(hot);
    if (hot) showChrome();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.length !== 1
    )
      return;
    if (document.querySelector("dialog[open]")) return;
    const target = event.target as Element | null;
    if (target?.matches?.("input, textarea, select, button, [contenteditable]"))
      return;
    showChrome();
    input()?.focus(); // the character is typed into the field right after this
  };
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.addEventListener("click", onClickCapture, true);
  window.addEventListener("pointermove", onPointerMove);
  document.addEventListener("keydown", onKeyDown);
  showChrome(); // visible at first so it can be found, then it tucks itself away
  return () => {
    window.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("keydown", onKeyDown);
  };
}
