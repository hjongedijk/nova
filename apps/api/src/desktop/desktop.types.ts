/** The desktop of the user's Windows PC, as the Windows agent exposes it (default OFF on the agent). */

export interface DesktopDisplay {
  index: number;
  width: number;
  height: number;
  primary?: boolean;
}

export interface DesktopAgentStatus {
  /** The agent has the desktop feature switched on at all. */
  viewAvailable: boolean;
  controlAvailable: boolean;
  /** The agent currently accepts input (armed through /v1/desktop/control). */
  armed: boolean;
  armedUntil?: number | null;
  displays?: DesktopDisplay[];
}

export interface DesktopWindow {
  id: string;
  title: string;
  process?: string;
  active: boolean;
  display?: number;
}

export interface DesktopScreenshot {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64 without data: prefix. Never logged, never stored. */
  base64: string;
  width: number;
  height: number;
  display: number;
}

export type DesktopInputAction =
  | {
      action: "move" | "click" | "doubleclick" | "rightclick";
      x: number;
      y: number;
    }
  | { action: "drag"; x: number; y: number; toX: number; toY: number }
  | { action: "scroll"; x?: number; y?: number; dx?: number; dy: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "focus_window"; windowId: string };

export const INPUT_ACTIONS = [
  "move",
  "click",
  "doubleclick",
  "rightclick",
  "drag",
  "scroll",
  "type",
  "key",
  "focus_window",
] as const;

export type DesktopOutcome<T = unknown> =
  ({ ok: true } & T) | { ok: false; error: string };

/** The agent boundary. The real client talks HTTP; tests inject a fake. Implementations must not throw. */
export interface DesktopPort {
  readonly configured: boolean;
  status(
    signal?: AbortSignal,
  ): Promise<DesktopOutcome<{ status: DesktopAgentStatus }>>;
  windows(
    signal?: AbortSignal,
  ): Promise<DesktopOutcome<{ windows: DesktopWindow[] }>>;
  screenshot(
    options: { display?: number; maxWidth?: number },
    signal?: AbortSignal,
  ): Promise<DesktopOutcome<{ screenshot: DesktopScreenshot }>>;
  input(
    input: DesktopInputAction & {
      display?: number;
      /** The screenshot size the coordinates refer to; the agent scales to the real display. */
      relativeTo?: { width: number; height: number };
    },
    signal?: AbortSignal,
  ): Promise<DesktopOutcome>;
  control(
    armed: boolean,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<DesktopOutcome>;
}
export const DESKTOP_PORT = Symbol("nova:desktop-port");

/** Sends a screenshot to the vision-role model through OmniRoute; fails closed (free only). */
export interface DesktopVision {
  describe(
    image: { mimeType: string; base64: string },
    question: string | undefined,
    signal?: AbortSignal,
  ): Promise<DesktopOutcome<{ description: string }>>;
}
export const DESKTOP_VISION = Symbol("nova:desktop-vision");

export interface DesktopSettings {
  /** NOVA may look at the screen (screenshots go to the free vision model). */
  viewEnabled: boolean;
  /** NOVA may take over mouse and keyboard in a confirmed session. */
  controlEnabled: boolean;
  /** Keep the last screen description for a few seconds. */
  cacheEnabled: boolean;
}

export interface DesktopSessionInfo {
  id: string;
  goal: string;
  startedAt: number;
  expiresAt: number;
  actions: number;
  maxActions: number;
  observations: number;
  lastActivityAt: number;
}
