import type { QuickAction } from "@nova/contracts";

/** The prototype's built-in quick actions, used until (or unless) /api/settings/public answers. */
export const DEFAULT_CHIPS: QuickAction[] = [
  {
    label: "Status van de servers",
    prompt: "Hoe is de status van de servers?",
  },
  {
    label: "Welke VM's draaien er?",
    prompt: "Welke virtuele machines draaien er en hoe druk zijn ze?",
  },
  { label: "Het weer", prompt: "Wat is het weer buiten?" },
  { label: "Wat kun je?", prompt: "Wat kun je allemaal voor me doen?" },
];

/** Switches and facts about the shell that several components read. */
export const shell = $state({
  /** The browser has speech recognition (Chrome, Edge, Safari). */
  speechSupported: false,
  /** "Hey NOVA" is switched on / the microphone is actually listening for it. */
  wakeEnabled: false,
  wakeActive: false,
  /** NOVA is waiting for a command after the wake word (or after asking something). */
  awaiting: false,
  /** Say timers and alerts aloud (menu: "Meldingen hardop"). */
  voiceAlerts: true,
  /** Info panels in the side columns (menu: "Info-panelen"). */
  panels: true,
  menuOpen: false,
  /** What is typed in the composer (the wake word handler clears it when it sends a spoken command). */
  draft: "",
  /** Header status: text and tone ("ok" / "bad" / ""). */
  statusText: "controleren…",
  statusTone: "" as "" | "ok" | "bad",
  routingNotice: "",
  quickActions: DEFAULT_CHIPS as QuickAction[],
  /** NOVA_PUBLIC_URL when a reverse proxy is set, else empty. */
  publicOrigin: "",
});

/** Where the secure (https) NOVA lives: the microphone needs it. */
export const secureBase = (): string =>
  shell.publicOrigin || `https://${location.hostname}:8443`;
export const plainBase = (): string =>
  shell.publicOrigin || `http://${location.hostname}:8080`;
