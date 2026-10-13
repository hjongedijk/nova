import { ToolsService } from "./tools.service.js";
import { TOOL_DISCOVERY_NAME } from "./tool-selection.js";
import {
  schema,
  text,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "./tool.types.js";

@ToolSourceProvider()
export class ToolCatalogSource implements ToolSource {
  readonly source = "nova";
  constructor(private readonly tools: ToolsService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: TOOL_DISCOVERY_NAME,
        description:
          "Find available NOVA tools by task, subject or integration name. Use this when the tool you need is not offered. Matching tool definitions become available in your next turn. This only discovers capabilities; call the actual tool to read live information or perform an action.",
        parameters: schema({ query: text(200) }),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    if (name !== TOOL_DISCOVERY_NAME || typeof args.query !== "string")
      return { ok: false, error: "Invalid tool search" };
    const found = this.tools.discoverForModel(
      args.query,
      call.readOnlyOnly === true,
    );
    const names = new Set(found.map((tool) => tool.function.name));
    const scoped = this.tools
      .list()
      .filter(
        (tool) =>
          tool.enabled && (!call.readOnlyOnly || tool.risk === "READ_ONLY"),
      );
    return {
      ok: true,
      verified: true,
      result: {
        tools: scoped
          .filter((tool) => names.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description.slice(0, 300),
            source: tool.source,
            risk: tool.risk,
          })),
        ...(found.length
          ? {}
          : {
              sources: [...new Set(scoped.map((tool) => tool.source))].slice(
                0,
                32,
              ),
            }),
        hint: found.length
          ? "Discovery only. Use the matching tools for live information or actions."
          : "No lexical match. Try a synonym or an integration name.",
      },
    };
  }
}
