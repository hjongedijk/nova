import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTimeout as sleep } from "node:timers/promises";

await sleep(2_000);
const server = new McpServer({ name: "slow", version: "1.0.0" });
server.registerTool(
  "slow_tool",
  { description: "Delayed startup", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "ready" }] }),
);
await server.connect(new StdioServerTransport());
