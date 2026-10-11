import { Module } from "@nestjs/common";
import { McpHub } from "./mcp.hub.js";
import { McpSource } from "./mcp.source.js";
import { McpSecretsStore } from "./mcp-secrets.store.js";

/** MCP client hub: starts the configured servers in the background and offers their tools. */
@Module({
  providers: [McpHub, McpSource, McpSecretsStore],
  exports: [McpHub, McpSecretsStore],
})
export class McpModule {}
