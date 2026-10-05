import { Module } from "@nestjs/common";
import { McpHub } from "./mcp.hub.js";
import { McpSource } from "./mcp.source.js";

/** MCP client hub: starts the configured servers in the background and offers their tools. */
@Module({
  providers: [McpHub, McpSource],
  exports: [McpHub],
})
export class McpModule {}
