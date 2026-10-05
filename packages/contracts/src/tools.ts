/** How careful NOVA must be with a tool. */
export type Risk = "READ_ONLY" | "SAFE" | "CONFIRM" | "DANGEROUS";

/** JSON Schema for a tool's arguments: always an object. */
export interface ArgumentSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A tool as the settings screen shows it. */
export interface ToolInfo {
  name: string;
  description: string;
  /** The built-in description when the user replaced it. */
  defaultDescription: string | null;
  /** Where the tool comes from: proxmox, home-assistant, windows, mcp, skills, ... */
  source: string;
  risk: Risk;
  enabled: boolean;
  /** Switched off by the user (as opposed to unavailable). */
  switchedOff: boolean;
  /** The description was changed by the user. */
  edited: boolean;
}
