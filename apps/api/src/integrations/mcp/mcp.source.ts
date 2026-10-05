import {
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../../tools/tool.types.js";
import { McpHub } from "./mcp.hub.js";

/** The tools of the connected MCP servers, named mcp_<server>_<tool>. */
@ToolSourceProvider()
export class McpSource implements ToolSource {
  readonly source = "mcp";

  constructor(private readonly hub: McpHub) {}

  definitions(): ToolDefinition[] {
    return this.hub.definitions();
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    return this.hub.execute(name, args, call.signal);
  }
}
