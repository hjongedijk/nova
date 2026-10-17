import {
  schema,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { AutopilotService } from "./autopilot.service.js";

/** Tools to see what the autopilot does and to switch it off or on (the kill switch). */
@ToolSourceProvider()
export class AutopilotSource implements ToolSource {
  readonly source = "autopilot";
  constructor(private readonly autopilot: AutopilotService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "autopilot_status",
        description:
          "Show what NOVA's autopilot did on her own: when it last checked, what it found, how many initiatives it sent today and when it checks next. Use it for 'wat heb je zelf gedaan' or 'is de autopilot aan'.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "autopilot_set",
        description:
          "Switch NOVA's autopilot (the routine checks and unprompted messages) on or off. enabled=false is the kill switch: 'stop met uit jezelf melden'.",
        parameters: schema({ enabled: { type: "boolean" } }, ["enabled"]),
        risk: "SAFE",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (name === "autopilot_status")
      return { ok: true, result: this.autopilot.status() };
    if (name === "autopilot_set" && typeof args.enabled === "boolean") {
      this.autopilot.setEnabled(args.enabled);
      return {
        ok: true,
        verified: true,
        result: { enabled: this.autopilot.settings.enabled },
      };
    }
    return { ok: false, error: "Onbekende autopilot-actie." };
  }
}
