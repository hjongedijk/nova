import type {
  PersonaStyleId,
  SettingsOverview,
  SidebarItem,
} from "@nova/contracts";
import type { ActionReceipt } from "#lib/stores/chat.svelte.ts";

/** Targets stay in memory for the read-back check; cards contain fixed, safe labels only. */
export type SettingsReceiptTarget =
  | { kind: "tool-switch"; name: string; enabled: boolean }
  | { kind: "sidebar"; items: SidebarItem[]; reset?: boolean }
  | { kind: "persona-style"; style: PersonaStyleId }
  | { kind: "persona-rules"; text: string };

let sequence = 0;

export function settingsActionReceipt(
  target: SettingsReceiptTarget,
  overview: SettingsOverview | null,
): ActionReceipt {
  const verified = overview === null ? false : checkReadback(target, overview);
  const requested =
    target.kind === "tool-switch"
      ? `Gereedschap ${target.enabled ? "inschakelen" : "uitschakelen"}`
      : target.kind === "sidebar"
        ? target.reset
          ? "Standaardindeling van de zijbalk herstellen"
          : "Zijbalkindeling aanpassen"
        : target.kind === "persona-style"
          ? "Gespreksstijl aanpassen"
          : "Eigen gespreksregels aanpassen";
  const performed =
    target.kind === "tool-switch"
      ? "Gereedschapsinstelling opgeslagen"
      : target.kind === "sidebar"
        ? "Zijbalkindeling opgeslagen"
        : target.kind === "persona-style"
          ? "Gespreksstijl opgeslagen"
          : "Eigen gespreksregels opgeslagen";
  const recoverHref =
    target.kind === "tool-switch"
      ? "/settings?section=system#tool-switch-history"
      : target.kind === "sidebar"
        ? "/settings?section=system#sidebar-history"
        : target.kind === "persona-style"
          ? "/settings?section=personality#persona-preferences-history"
          : "/settings?section=personality#persona-history";
  return {
    id: `settings-${Date.now()}-${++sequence}`,
    requested,
    performed,
    verification: verified
      ? "Opgeslagen waarde opnieuw gelezen en gecontroleerd"
      : "Opslag bevestigd; nieuwe waarde niet gecontroleerd",
    recoverHref,
  };
}

function checkReadback(
  target: SettingsReceiptTarget,
  overview: SettingsOverview,
): boolean {
  switch (target.kind) {
    case "tool-switch":
      return overview.tools.some(
        (tool) =>
          tool.name === target.name && tool.switchedOff === !target.enabled,
      );
    case "sidebar":
      return JSON.stringify(overview.sidebar) === JSON.stringify(target.items);
    case "persona-style":
      return overview.personaStyle === target.style;
    case "persona-rules":
      return overview.persona === target.text;
  }
}
