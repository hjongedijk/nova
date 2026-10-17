/**
 * NOVA Desk: the native Windows shell (Tauri) that can show the helper in a frameless window. Inside it the page
 * finds `window.__TAURI__` and may call the few commands NOVA Desk gives the helper window; in a browser (Edge app
 * window, a normal tab) none of this exists and the helper keeps its old behaviour.
 */
type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function invoker(): Invoke | null {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } })
    .__TAURI__;
  return typeof tauri?.core?.invoke === "function" ? tauri.core.invoke : null;
}

/** True when the page runs inside NOVA Desk and can call it. */
export const inDesk = (): boolean => invoker() !== null;

/**
 * True for the desk look: transparent page, the panel itself is the rounded shape. NOVA Desk marks the page before
 * it loads; `?desk=1` does the same (and lets the look be tested in a plain browser).
 */
export function deskLook(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.classList.contains("desk")) return true;
  return new URLSearchParams(location.search).get("desk") === "1";
}

export interface DeskInfo {
  version: string;
  /** 1-based number of the display the helper is on. */
  display: number;
  displays: {
    index: number;
    name: string;
    primary: boolean;
    width: number;
    height: number;
  }[];
  fullscreen: boolean;
}

/** Calls a NOVA Desk command; rejects when the page is not inside NOVA Desk. */
export async function deskInvoke<T = void>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = invoker();
  if (!invoke) throw new Error("NOVA Desk is niet beschikbaar");
  return (await invoke(command, args)) as T;
}
