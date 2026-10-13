import type { SettingsOverview, SidebarItem } from "@nova/contracts";
import type { ActionReceipt } from "#lib/stores/chat.svelte.ts";

/** Targets stay in memory for the read-back check; cards contain fixed, safe labels only. */
export type SettingsReceiptTarget =
  | { kind: "tool-switch"; name: string; enabled: boolean }
  | { kind: "sidebar"; items: SidebarItem[]; reset?: boolean };

let sequence = 0;

export function settingsActionReceipt(
  target: SettingsReceiptTarget,
  overview: SettingsOverview | null,
): ActionReceipt {
  const isTool = target.kind === "tool-switch";
  const verified =
    overview === null
      ? false
      : isTool
        ? overview.tools.some(
            (tool) =>
              tool.name === target.name && tool.switchedOff === !target.enabled,
          )
        : JSON.stringify(overview.sidebar) === JSON.stringify(target.items);
  return {
    id: `settings-${Date.now()}-${++sequence}`,
    requested: isTool
      ? `Gereedschap ${target.enabled ? "inschakelen" : "uitschakelen"}`
      : target.reset
        ? "Standaardindeling van de zijbalk herstellen"
        : "Zijbalkindeling aanpassen",
    performed: isTool
      ? "Gereedschapsinstelling opgeslagen"
      : "Zijbalkindeling opgeslagen",
    verification: verified
      ? "Opgeslagen waarde opnieuw gelezen en gecontroleerd"
      : "Opslag bevestigd; nieuwe waarde niet gecontroleerd",
    recoverHref: isTool
      ? "/settings?section=system#tool-switch-history"
      : "/settings?section=system#sidebar-history",
  };
}
