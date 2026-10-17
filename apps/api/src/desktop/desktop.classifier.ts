import type { DesktopInputAction, DesktopWindow } from "./desktop.types.js";
import { DESKTOP_LIMITS } from "./desktop.limits.js";

export type DesktopActionLevel = "benign" | "risky" | "unknown";
export interface DesktopClassification {
  level: DesktopActionLevel;
  reason: string;
}

/**
 * Windows where an action can pay, delete, send, sign in or run commands. The text is the window title
 * plus the process name that the agent reports; it is matched, never trusted as an instruction.
 */
const RISKY_WINDOW =
  /\b(pay|payment|paypal|ideal|checkout|afrekenen|betaal\w*|bestelling|order|bank\w*|bunq|rabobank|abn ?amro|ing|creditcard|credit card|wallet|crypto|overboeking|transfer|invoice|factuur|delete|verwijder\w*|remove|uninstall|format|wissen|prullenbak|recycle|password|wachtwoord|passkey|login|log ?in|sign ?in|inloggen|aanmelden|2fa|verification|authenticator|credential\w*|keepass\w*|bitwarden|1password|lastpass|compose|new message|nieuw bericht|inbox|postvak|outlook|gmail|mail|slack|teams|whatsapp|telegram|discord|signal|message|bericht|regedit|registry|powershell|cmd|terminal|command prompt|opdrachtprompt|task manager|taakbeheer|uac|user account control|windows security|windows-beveiliging|instellingen|settings|admin\w*)\b/i;
const FILE_MANAGER =
  /\b(explorer|verkenner|file explorer|bestandsverkenner)\b/i;
const BROWSER = /\b(chrome|edge|firefox|brave|opera|vivaldi|browser)\b/i;
/** Windows NOVA never photographs: the picture would leave the PC. */
const SENSITIVE_VIEW =
  /\b(keepass\w*|bitwarden|1password|lastpass|password|wachtwoord|passkey|bunq|rabobank|abn ?amro|bank\w*|inloggen|sign ?in|log ?in)\b/i;

const CREDENTIAL_TEXT = [
  /pass(?:word|wd)?|wachtwoord|\bpin\b|token|secret|api[_ -]?key|bearer|private key|seed phrase|cvv|cvc/i,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\b[A-Za-z0-9+/=_-]{32,}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/,
];

const SAFE_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "tab",
  "shift+tab",
  "pageup",
  "pagedown",
  "home",
  "end",
  "escape",
  "esc",
  "ctrl+c",
  "ctrl+f",
  "ctrl+a",
  "ctrl+tab",
  "ctrl+shift+tab",
  "f5",
]);
const SUBMIT_KEYS = new Set(["enter", "return"]);

const windowText = (window: DesktopWindow | undefined) =>
  `${window?.title ?? ""} ${window?.process ?? ""}`;

/** May NOVA photograph this window? */
export function viewAllowed(windows: DesktopWindow[]): boolean {
  const active = windows.filter((window) => window.active);
  return !active.some((window) => SENSITIVE_VIEW.test(windowText(window)));
}

/**
 * Conservative classification of a proposed action by what it does and the window it lands in.
 * Anything not positively known to be harmless is "risky" or "unknown"; both need a fresh confirmation.
 */
export function classifyAction(
  input: DesktopInputAction,
  windows: DesktopWindow[] | null,
): DesktopClassification {
  if (input.action === "move" || input.action === "scroll")
    return { level: "benign", reason: "pointer" };

  if (input.action === "key") {
    const key = input.key.trim().toLowerCase();
    if (SAFE_KEYS.has(key))
      return { level: "benign", reason: "navigation key" };
    if (!SUBMIT_KEYS.has(key))
      return { level: "unknown", reason: "unrecognised key combination" };
  }

  if (input.action === "type") {
    if (input.text.length > DESKTOP_LIMITS.maxTypedCharacters)
      return { level: "unknown", reason: "long text" };
    if (/[\r\n]/.test(input.text))
      return { level: "risky", reason: "text that submits" };
    if (CREDENTIAL_TEXT.some((pattern) => pattern.test(input.text)))
      return { level: "risky", reason: "credential-looking text" };
  }

  if (!windows) return { level: "unknown", reason: "window unknown" };

  let target: DesktopWindow | undefined;
  if (input.action === "focus_window") {
    target = windows.find((window) => window.id === input.windowId);
    if (!target) return { level: "unknown", reason: "window not found" };
  } else {
    const active = windows.filter((window) => window.active);
    if (active.length !== 1)
      return { level: "unknown", reason: "active window unclear" };
    target = active[0];
  }
  if (!target) return { level: "unknown", reason: "window unknown" };
  const text = windowText(target);
  if (!target.title.trim())
    return { level: "unknown", reason: "untitled window" };
  if (RISKY_WINDOW.test(text))
    return { level: "risky", reason: "sensitive window" };
  if (
    FILE_MANAGER.test(text) &&
    input.action !== "click" &&
    input.action !== "focus_window"
  )
    return { level: "risky", reason: "file manager" };
  if (input.action === "key" && BROWSER.test(text))
    return { level: "risky", reason: "submit in browser" };
  return { level: "benign", reason: "ordinary window" };
}
