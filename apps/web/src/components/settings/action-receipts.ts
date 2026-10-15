import type {
  PersonaStyleId,
  QuickAction,
  SettingsOverview,
  SidebarItem,
} from "@nova/contracts";
import type { ActionReceipt } from "#lib/stores/chat.svelte.ts";

/** Targets stay in memory for the read-back check; cards contain fixed, safe labels only. */
export type SettingsReceiptTarget =
  | { kind: "tool-switch"; name: string; enabled: boolean }
  | { kind: "tool-description"; name: string; description: string | null }
  | { kind: "sidebar"; items: SidebarItem[]; reset?: boolean }
  | { kind: "persona-style"; style: PersonaStyleId }
  | { kind: "persona-rules"; text: string }
  | {
      kind: "quick-actions";
      items: QuickAction[];
      operation: "save" | "reset" | "rollback";
    };

let sequence = 0;

export function settingsActionReceipt(
  target: SettingsReceiptTarget,
  overview: SettingsOverview | null,
): ActionReceipt {
  const verified = overview === null ? false : checkReadback(target, overview);
  const requested =
    target.kind === "tool-switch"
      ? `Gereedschap ${target.enabled ? "inschakelen" : "uitschakelen"}`
      : target.kind === "tool-description"
        ? target.description === null
          ? "Standaardbeschrijving van gereedschap herstellen"
          : "Gereedschapsbeschrijving aanpassen"
        : target.kind === "sidebar"
          ? target.reset
            ? "Standaardindeling van de zijbalk herstellen"
            : "Zijbalkindeling aanpassen"
          : target.kind === "quick-actions"
            ? target.operation === "reset"
              ? "Standaard snelle opdrachten herstellen"
              : target.operation === "rollback"
                ? "Eerdere snelle opdrachten herstellen"
                : "Snelle opdrachten aanpassen"
            : target.kind === "persona-style"
              ? "Gespreksstijl aanpassen"
              : "Eigen gespreksregels aanpassen";
  const performed =
    target.kind === "tool-switch"
      ? "Gereedschapsinstelling opgeslagen"
      : target.kind === "tool-description"
        ? "Gereedschapsbeschrijving opgeslagen"
        : target.kind === "sidebar"
          ? "Zijbalkindeling opgeslagen"
          : target.kind === "quick-actions"
            ? target.operation === "rollback"
              ? "Snelle opdrachten hersteld"
              : "Snelle opdrachten opgeslagen"
            : target.kind === "persona-style"
              ? "Gespreksstijl opgeslagen"
              : "Eigen gespreksregels opgeslagen";
  const recoverHref =
    target.kind === "tool-switch"
      ? "/settings?section=system#tool-switch-history"
      : target.kind === "tool-description"
        ? "/settings?section=abilities"
        : target.kind === "sidebar"
          ? "/settings?section=system#sidebar-history"
          : target.kind === "quick-actions"
            ? "/settings?section=general#quick-actions-history"
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
    case "tool-description":
      return overview.tools.some(
        (tool) =>
          tool.name === target.name &&
          (target.description === null
            ? tool.edited === false
            : tool.description === target.description),
      );
    case "sidebar":
      return JSON.stringify(overview.sidebar) === JSON.stringify(target.items);
    case "persona-style":
      return overview.personaStyle === target.style;
    case "persona-rules":
      return overview.persona === target.text;
    case "quick-actions":
      return (
        JSON.stringify(overview.quickActions) === JSON.stringify(target.items)
      );
  }
}
