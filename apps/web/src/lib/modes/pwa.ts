/** Install NOVA as an app: the service worker, the install prompt and what the settings dialog needs. */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = "installed" | "available" | "unavailable";

let installPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const isInstalled = () =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

/** "installed" (running as an app), "available" (the browser offers to install) or "unavailable". */
export function installState(): InstallState {
  if (isInstalled()) return "installed";
  return installPrompt ? "available" : "unavailable";
}

/** Show the browser's install dialog. Resolves true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const prompt = installPrompt;
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  installPrompt = null;
  changed();
  return outcome === "accepted";
}

/** Call back when the install state changes (the browser offered it, or the app was installed). */
export function onInstallStateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Register /sw.js and listen for the install prompt. Returns the cleanup. */
export function startPwa(): () => void {
  const offer = (event: Event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    changed();
  };
  const installed = () => {
    installPrompt = null;
    changed();
  };
  window.addEventListener("beforeinstallprompt", offer);
  window.addEventListener("appinstalled", installed);
  if ("serviceWorker" in navigator && window.isSecureContext)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  return () => {
    window.removeEventListener("beforeinstallprompt", offer);
    window.removeEventListener("appinstalled", installed);
  };
}
