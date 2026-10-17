/** Always-visible meta tools. Everything else from the api source is a per-operation tool. */
export const API_META_TOOLS: ReadonlySet<string> = new Set([
  "api_connect",
  "api_list",
  "api_describe",
  "api_test",
  "api_remove",
  "api_refresh",
  "api_attach_docs",
  "api_call",
  "api_configure",
  "api_workflow_plan",
]);

/** Cap for per-operation tools in one model turn. */
export const MAX_API_OPERATION_TOOLS = 12;

export const isApiOperationTool = (name: string): boolean =>
  name.startsWith("api_") && !API_META_TOOLS.has(name);
