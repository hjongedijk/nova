/*
 * The reactive window store: one WindowState, changed only through manager.ts and feed.ts, plus the stage size
 * and a settle timer. Components read `windows.state`; the chat stream calls `feedWindows`.
 */
import { applyFeed, type FeedEvent } from "./feed.ts";
import {
  closeWindow,
  emptyState,
  focusWindow,
  minimizeWindow,
  moveWindow,
  openWindow,
  settle,
  toggleMaximize,
  type OpenSpec,
  type Rect,
  type Stage,
  type WindowState,
} from "./manager.ts";
import { writeTerminal } from "./terminals.ts";

function measureStage(): Stage {
  if (typeof window === "undefined")
    return { w: 1280, h: 800, top: 64, bottom: 120 };
  const taskbar =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--taskbar"),
    ) || 0;
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    top: window.innerWidth < 640 ? 56 : 68,
    bottom: (window.innerWidth < 640 ? 96 : 124) + taskbar,
  };
}

class Windows {
  state = $state<WindowState>(emptyState());
  stage = $state<Stage>(measureStage());
  private timer: ReturnType<typeof setInterval> | null = null;

  private set(next: WindowState) {
    if (next !== this.state) this.state = next;
    this.ensureTimer();
  }

  private ensureTimer() {
    if (
      this.timer ||
      typeof window === "undefined" ||
      !this.state.windows.length
    )
      return;
    this.timer = setInterval(() => {
      this.set(settle(this.state, Date.now()));
      if (!this.state.windows.length && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 2000);
  }

  measure() {
    this.stage = measureStage();
  }

  feed(event: FeedEvent) {
    if (event.type === "terminal" && event.data?.phase === "data") {
      writeTerminal(event.data.id, event.data.data);
      return;
    }
    this.set(applyFeed(this.state, event, this.stage, Date.now()));
  }

  open(spec: OpenSpec) {
    this.set(openWindow(this.state, spec, this.stage, Date.now()));
  }
  focus(id: string) {
    if (
      this.state.focused === id &&
      this.state.windows.find((w) => w.id === id)?.mode !== "minimized"
    )
      return;
    this.set(focusWindow(this.state, id));
  }
  close(id: string) {
    this.set(closeWindow(this.state, id));
  }
  minimize(id: string) {
    this.set(minimizeWindow(this.state, id));
  }
  maximize(id: string) {
    this.set(toggleMaximize(this.state, id));
  }
  move(id: string, rect: Partial<Rect>) {
    this.set(moveWindow(this.state, id, rect, this.stage));
  }
  setLayout(layout: WindowState["layout"]) {
    this.set({ ...this.state, layout, mission: false });
  }
  mission(on = !this.state.mission) {
    this.set({ ...this.state, mission: on && this.state.windows.length > 0 });
  }
}

export const windows = new Windows();

/** Called from the chat stream. */
export const feedWindows = (event: FeedEvent) => windows.feed(event);

// Development only: lets preview scripts drive the windows without a running API.
if (import.meta.env?.DEV && typeof window !== "undefined")
  (window as unknown as { __novaWindows?: unknown }).__novaWindows = {
    feed: feedWindows,
    windows,
  };
