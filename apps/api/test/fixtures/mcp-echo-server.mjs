import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo text",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
server.registerTool(
  "write_note",
  { description: "Pretend to write", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `wrote ${text}` }] }),
);
await server.connect(new StdioServerTransport());
