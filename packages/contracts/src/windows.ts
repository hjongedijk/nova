// NOVA's floating windows: what the API tells the screen to open, terminal output as it arrives, and the
// live-video protocol of /api/live. Types only.

/** Every kind of window the window manager can show. */
export type NovaWindowKind =
  | "browser"
  | "screen"
  | "terminal"
  | "video"
  | "page"
  | "reader"
  | "image"
  | "document"
  | "code"
  | "data";

/** Where a click or keystroke landed, normalised to 0..1 of the picture, for the overlay on a live window. */
export interface NovaActionOverlay {
  kind: "click" | "type" | "key" | "scroll" | "move";
  x?: number;
  y?: number;
  /** Typed text as shown to the owner: masked when the field was a password. */
  text?: string;
  key?: string;
}

export interface NovaVideoSource {
  provider: "youtube" | "vimeo" | "file" | "hls";
  /** youtube/vimeo: the video id; file/hls: the media URL (http/https only). */
  id?: string;
  url?: string;
  /** Seconds to start at. */
  start?: number;
}

/**
 * SSE event "window": open (or update, same id) one window. Sent by the window_open tool and by results that
 * deserve a big view (web_read reader, final browser page). Everything inside is display-only and sanitised.
 */
export interface NovaWindowEvent {
  id: string;
  kind: NovaWindowKind;
  title?: string;
  /** http/https page, image, document or media address. */
  url?: string;
  video?: NovaVideoSource;
  /** reader / document (markdown) / code: text to show, capped server side. */
  text?: string;
  /** code: the language or "diff". */
  language?: string;
  /** data: label/value rows. */
  rows?: { label: string; value: string }[];
  /** reader: the site's host name. */
  domain?: string;
  /** Mark this window as the end result of the turn (shown large). */
  result?: boolean;
}

/** SSE event "terminal": a live terminal window's lifecycle and output, chunk by chunk, redacted. */
export type NovaTerminalEvent =
  | {
      id: string;
      phase: "start";
      host?: string;
      user?: string;
      command: string;
      tool: string;
    }
  | { id: string; phase: "data"; stream: "stdout" | "stderr"; data: string }
  | {
      id: string;
      phase: "end";
      exitCode?: number | null;
      durationMs: number;
      ok: boolean;
    };

/** Live streams /api/live serves. */
export type LiveStreamKind = "browser" | "desktop";

/** Client → server over /api/live (JSON text messages). */
export type LiveClientMessage =
  | {
      type: "subscribe";
      /** The client's own name for this subscription (one per window). */
      key: string;
      stream: LiveStreamKind;
      display?: number;
      tab?: string;
      fps: number;
      maxWidth: number;
    }
  | { type: "budget"; key: string; fps: number; maxWidth: number }
  | { type: "unsubscribe"; key: string };

/** Server → client status (JSON text). Frames arrive as binary messages: see LIVE_FRAME_HEADER in the API. */
export interface LiveStatusMessage {
  type: "status";
  key: string;
  /** live: real video; snapshot: screenshot refresh (old agent); offline: nothing to show. */
  state: "connecting" | "live" | "snapshot" | "offline";
  reason?: string;
}

/** JSON header in front of every binary frame. */
export interface LiveFrameHeader {
  key: string;
  seq: number;
  width: number;
  height: number;
  mime: "image/jpeg";
  /** Browser frames: address, title and CSS viewport of the tab. */
  url?: string;
  title?: string;
  tab?: string;
  vw?: number;
  vh?: number;
}
