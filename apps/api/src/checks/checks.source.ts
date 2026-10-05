import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { ChecksService } from "./checks.service.js";

@ToolSourceProvider()
export class ChecksSource implements ToolSource {
  readonly source = "checks";

  constructor(private readonly checks: ChecksService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "alerts_list",
        description:
          "Recent alerts raised by the NOVA watchdog: stopped VMs, offline nodes, full storage and unreachable services. Says which are still open.",
        parameters: schema({ limit: integer(1, 20) }, []),
        risk: "READ_ONLY",
      },
      {
        name: "network_check",
        description:
          "Check whether the NOVA services (API, OmniRoute, MQTT, speech, Qdrant, Home Assistant, Proxmox) answer, with response times. Give a target name to check only one. Use it when something seems down or slow.",
        parameters: schema({ target: text(40) }, []),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      if (name === "alerts_list")
        return {
          ok: true,
          result: { alerts: this.checks.alerts(Number(args.limit) || 10) },
        };
      const results = await this.checks.check(
        typeof args.target === "string" ? args.target : undefined,
      );
      return {
        ok: true,
        result: { allUp: results.every((r) => r.ok), results },
      };
    } catch (error) {
      return {
        ok: false,
        error: String((error as Error).message || error).slice(0, 300),
      };
    }
  }
}
