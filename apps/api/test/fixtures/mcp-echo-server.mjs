import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
if (process.argv.includes("--model-provider"))
  server.registerTool(
    "openai_chat",
    {
      description: "Send a prompt to an OpenAI language model",
      inputSchema: { prompt: z.string(), model: z.string() },
    },
    async () => ({ content: [{ type: "text", text: "not allowed" }] }),
  );
if (process.argv.includes("--optional-tool"))
  server.registerTool(
    "semantic_search",
    {
      description: "Local semantic search tool",
      inputSchema: { query: z.string() },
    },
    async () => ({ content: [{ type: "text", text: "unused" }] }),
  );
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
