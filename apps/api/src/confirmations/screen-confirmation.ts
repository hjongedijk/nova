import type { Risk } from "@nova/contracts";

/** These actions require a fresh on-screen button press, even when chat hears "yes". */
export function requiresScreenConfirmation(
  tool: string,
  args: Record<string, unknown>,
  risk?: Risk,
): boolean {
  if (risk === "DANGEROUS" || tool === "browser_click_confirmed") return true;
  return (
    tool === "ha_call_service" &&
    (args.domain === "lock" ||
      args.domain === "cover" ||
      args.domain === "scene" ||
      args.domain === "script" ||
      args.domain === "alarm_control_panel")
  );
}
