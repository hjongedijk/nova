import {
  schema,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { localTime } from "./system-time.js";

@ToolSourceProvider()
export class SystemTimeSource implements ToolSource {
  readonly source = "system";

  constructor(private readonly config: NovaConfig) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "system_time",
        description:
          "Get the current date and time. Tell the user local.spoken (for example tien voor zes) with local.partOfDay, or local.time when they want it exact. Never convert the UTC iso yourself.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(): Promise<ToolResult> {
    const now = new Date();
    return {
      ok: true,
      result: {
        iso: now.toISOString(),
        timestamp: now.getTime(),
        serverTimezone: this.config.timezone,
        local: localTime(now, this.config.timezone),
      },
    };
  }
}
