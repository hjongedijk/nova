/*
 * Turns the chat stream into windows: browser_* steps feed one live browser window, desktop_* steps the live
 * screen window, command tools a terminal per command, window events whatever they ask for. When a turn that used
 * the browser ends, its last page opens large as the result. Pure: state in, state out.
 */
import type {
  NovaActionOverlay,
  NovaTerminalEvent,
  NovaWindowEvent,
  NovaWindowKind,
} from "@nova/contracts";
import {
  finishRunning,
  openWindow,
  type Stage,
  type WindowState,
} from "./manager.ts";

export type FeedEvent =
  | { type: "tool_start"; data: Record<string, unknown> | null }
  | { type: "tool_result"; data: Record<string, unknown> | null }
  | { type: "window"; data: NovaWindowEvent }
  | { type: "terminal"; data: NovaTerminalEvent }
  | { type: "turn_end" };

export const BROWSER_WINDOW = "browser";
export const SCREEN_WINDOW = "screen";
const KINDS = new Set<NovaWindowKind>([
  "browser",
  "screen",
  "terminal",
  "video",
  "page",
  "reader",
  "image",
  "document",
  "code",
  "data",
]);

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;
const str = (value: unknown, max = 600) =>
  typeof value === "string" ? value.slice(0, max) : "";
const httpUrl = (value: unknown) => {
  const text = str(value, 2000);
  return /^https?:\/\//i.test(text) ? text : "";
};

const isBrowserStep = (name: string) =>
  /^browser_/.test(name) && name !== "browser_status";
const isScreenStep = (name: string) =>
  name === "desktop_screenshot" ||
  name === "desktop_act" ||
  name === "desktop_takeover_start";

function overlay(
  value: unknown,
  now: number,
): (NovaActionOverlay & { at: number }) | null {
  const action = rec(value);
  if (!action || typeof action.kind !== "string") return null;
  const unit = (n: unknown) =>
    typeof n === "number" && n >= 0 && n <= 1 ? n : undefined;
  return {
    kind: action.kind as NovaActionOverlay["kind"],
    ...(unit(action.x) !== undefined ? { x: unit(action.x) } : {}),
    ...(unit(action.y) !== undefined ? { y: unit(action.y) } : {}),
    ...(str(action.text, 80) ? { text: str(action.text, 80) } : {}),
    ...(str(action.key, 30) ? { key: str(action.key, 30) } : {}),
    at: now,
  };
}

export function applyFeed(
  state: WindowState,
  event: FeedEvent,
  stage: Stage,
  now: number,
): WindowState {
  if (event.type === "turn_end") {
    const browser = state.windows.find((win) => win.id === BROWSER_WINDOW);
    let next = finishRunning(state, now);
    next = {
      ...next,
      windows: next.windows.map((win) =>
        win.data.loading
          ? { ...win, data: { ...win.data, loading: false } }
          : win,
      ),
    };
    const url = httpUrl(browser?.data.url);
    if (browser && browser.data.turn === true && url) {
      next = openWindow(
        next,
        {
          id: `result-${browser.openedAt.toString(36)}`,
          kind: "page",
          title:
            str(browser.data.pageTitle, 160) ||
            (browser.title !== "Browser" ? browser.title : "") ||
            new URL(url).hostname,
          phase: "done",
          result: true,
          data: { url, snapshotOf: BROWSER_WINDOW },
        },
        stage,
        now,
      );
      next = {
        ...next,
        windows: next.windows.map((win) =>
          win.id === BROWSER_WINDOW
            ? { ...win, data: { ...win.data, turn: false } }
            : win,
        ),
      };
    }
    return next;
  }

  if (event.type === "window") {
    const data = event.data;
    if (!data || typeof data.id !== "string" || !KINDS.has(data.kind))
      return state;
    return openWindow(
      state,
      {
        id: `w-${data.id}`.slice(0, 80),
        kind: data.kind,
        title: str(data.title, 160),
        phase: "done",
        result: data.result === true,
        data: { ...data },
      },
      stage,
      now,
    );
  }

  if (event.type === "terminal") {
    const data = event.data;
    if (!data || typeof data.id !== "string") return state;
    const id = `t-${data.id}`.slice(0, 80);
    if (data.phase === "start")
      return openWindow(
        state,
        {
          id,
          kind: "terminal",
          title: data.host
            ? `ssh ${data.user ? `${data.user}@` : ""}${data.host}`
            : data.tool === "code_run_tests"
              ? "Tests"
              : "Terminal",
          phase: "running",
          data: {
            terminal: data.id,
            host: data.host ?? "",
            command: data.command,
            startedAt: now,
          },
        },
        stage,
        now,
      );
    if (data.phase === "end")
      return openWindow(
        state,
        {
          id,
          kind: "terminal",
          phase: data.ok && (data.exitCode ?? 0) === 0 ? "done" : "failed",
          data: {
            exitCode: data.exitCode ?? null,
            durationMs: data.durationMs,
          },
          quiet: true,
        },
        stage,
        now,
      );
    return state;
  }

  const data = event.data;
  const name = str(data?.name, 80);
  const preview = rec(data?.preview);
  if (isBrowserStep(name)) {
    const url = httpUrl(preview?.url);
    const title = str(preview?.title, 160);
    if (event.type === "tool_start")
      return openWindow(
        state,
        {
          id: BROWSER_WINDOW,
          kind: "browser",
          title: title || "Browser",
          phase: "running",
          data: {
            loading: /^browser_(open|search|back|click|click_confirmed)$/.test(
              name,
            ),
            step: name,
            turn: true,
            ...(url ? { url } : {}),
          },
          quiet: state.windows.some((w) => w.id === BROWSER_WINDOW),
        },
        stage,
        now,
      );
    const action = overlay(preview?.action, now);
    return openWindow(
      state,
      {
        id: BROWSER_WINDOW,
        kind: "browser",
        ...(title ? { title } : {}),
        phase: data?.ok === false ? "failed" : "running",
        data: {
          loading: false,
          ...(url ? { url } : {}),
          ...(title ? { pageTitle: title } : {}),
          ...(action ? { action } : {}),
        },
        quiet: true,
      },
      stage,
      now,
    );
  }
  if (isScreenStep(name)) {
    const action =
      event.type === "tool_result" ? overlay(preview?.action, now) : null;
    return openWindow(
      state,
      {
        id: SCREEN_WINDOW,
        kind: "screen",
        title: "Scherm",
        phase:
          event.type === "tool_result" && data?.ok === false
            ? "failed"
            : "running",
        data: action ? { action } : {},
        quiet: state.windows.some((w) => w.id === SCREEN_WINDOW),
      },
      stage,
      now,
    );
  }
  return state;
}

/** Tools whose steps the window manager shows; the small activity windows skip them. */
export const handledByWindows = (name: unknown) =>
  typeof name === "string" &&
  (isBrowserStep(name) ||
    isScreenStep(name) ||
    name === "termix_run_command" ||
    name === "code_run_tests" ||
    name === "window_open");
