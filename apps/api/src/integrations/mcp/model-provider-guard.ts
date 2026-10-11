import type { McpServerSpec } from "./mcp-config.js";

const PROVIDER =
  /(?:^|[^a-z0-9])(?:openai|anthropic|claude|gemini|google[_\s-]+generative[_\s-]+ai|openrouter|hugging[_\s-]*face|replicate|ollama)(?=$|[^a-z0-9])|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api-inference\.huggingface\.co/i;
const MODEL_ACTION =
  /\b(?:chat\s*completion|text\s+generation|language\s+model|llm|inference|generate\s+(?:text|response)|completion\s+request)\b/i;
const MODEL_INPUT = /\b(?:prompt|messages|model|provider|api[_-]?key)\b/i;

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 100_000);
  } catch {
    return "";
  }
}

/** Metadata gate for MCP tools that declare language-model/provider access. */
export function declaresModelProviderAccess(
  id: string,
  spec: McpServerSpec,
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>,
): boolean {
  const serverMetadata = stringify({
    id,
    command: spec.command,
    args: spec.args,
    env: spec.env,
  });
  if (PROVIDER.test(serverMetadata)) return true;

  return tools.some((tool) => {
    const declaration = `${tool.name}\n${tool.description ?? ""}\n${stringify(tool.inputSchema)}`;
    if (PROVIDER.test(declaration)) return true;
    return (
      MODEL_ACTION.test(declaration) &&
      MODEL_INPUT.test(stringify(tool.inputSchema))
    );
  });
}
