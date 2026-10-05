import {
  schema,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
  ToolSourceProvider,
} from "../tools/tool.types.js";
import { IntegrationsHealth } from "./integrations-health.service.js";

/** One read-only tool about NOVA itself. */
@ToolSourceProvider()
export class SystemSource implements ToolSource {
  readonly source = "nova";

  constructor(private readonly health: IntegrationsHealth) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "system_integrations",
        description:
          "Read integration readiness, installed Home Assistant capabilities and semantic memory health.",
        parameters: schema(),
        risk: "READ_ONLY",
        timeoutMs: 15_000,
      },
    ];
  }

  async execute(): Promise<ToolResult> {
    return { ok: true, result: await this.health.forTool() };
  }
}
