import {
  schema,
  ToolSourceProvider,
  type ToolCall,
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
          "Read the current date and time from NOVA's server clock. Use for 'hoe laat is het', 'wat is de tijd', 'welke dag/datum is het', 'what time/day/date is it'. Optional timezone is an IANA name, for example Europe/Amsterdam or Asia/Tokyo; omit it for the configured timezone. Use local.spoken and local.partOfDay for natural Dutch time, local.time for exact minutes, or local.timeWithSeconds for explicit seconds. Never convert the UTC iso yourself. This tool needs no network lookup.",
        parameters: schema(
          { timezone: { type: "string", minLength: 1, maxLength: 100 } },
          [],
        ),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(
    _name?: string,
    args: Record<string, unknown> = {},
    call?: ToolCall,
  ): Promise<ToolResult> {
    if (call?.signal?.aborted)
      return { ok: false, error: "Tijdslimiet bereikt" };
    const requested =
      args.timezone === undefined ? this.config.timezone : args.timezone;
    const invalid = {
      ok: false as const,
      error: "Gebruik een geldige IANA-tijdzone, zoals Europe/Amsterdam.",
    };
    if (typeof requested !== "string" || !requested || requested.length > 100)
      return invalid;
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: requested,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      return invalid;
    }
    const now = new Date();
    const timezone = formatter.resolvedOptions().timeZone;
    const parts = formatter.formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? "";
    return {
      ok: true,
      result: {
        iso: now.toISOString(),
        timestamp: now.getTime(),
        serverTimezone: this.config.timezone,
        timezone,
        local: {
          ...localTime(now, timezone),
          isoDate: `${part("year")}-${part("month")}-${part("day")}`,
          timeWithSeconds: `${part("hour")}:${part("minute")}:${part("second")}`,
        },
      },
    };
  }
}
