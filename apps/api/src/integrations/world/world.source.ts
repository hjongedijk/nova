import {
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../../tools/tool.types.js";
import { WORLD_TOOL_NAMES, worldDefinitions } from "./world.definitions.js";
import { WorldService } from "./world.service.js";

/** Weather, air, moon, ISS, markets, news, Wikipedia, web search/read, currency, calculator. */
@ToolSourceProvider()
export class WorldSource implements ToolSource {
  readonly source = "world";

  constructor(private readonly world: WorldService) {}

  definitions(): ToolDefinition[] {
    return worldDefinitions();
  }

  owns(name: string): boolean {
    return (WORLD_TOOL_NAMES as readonly string[]).includes(name);
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    return this.world.execute(name, args, call.signal);
  }
}
