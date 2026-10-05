import crypto from "node:crypto";
import fs from "node:fs";
import type { Risk } from "@nova/contracts";

export const RISKS: readonly Risk[] = [
  "READ_ONLY",
  "SAFE",
  "CONFIRM",
  "DANGEROUS",
];

/** One entry of `servers` in mcp-servers.json. */
export interface McpServerSpec {
  command: string;
  args?: string[];
  /** Values may reference ${VARS}; a server whose variables are unset stays offline. */
  env?: Record<string, string>;
  /** Default risk for tools that do not declare readOnlyHint. Default CONFIRM. */
  risk?: string;
  enabled?: boolean;
}

/** The servers in the config file; a missing or broken file means none. */
export function readMcpServers(file: string): Record<string, McpServerSpec> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      servers?: Record<string, McpServerSpec>;
    };
    return parsed.servers && typeof parsed.servers === "object"
      ? parsed.servers
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve "${VAR}" references against the process environment (this is the one place that has
 * to read it: the names come from the config file). Unset variables name the missing ones.
 */
export function resolveEnv(
  env: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
):
  { env: Record<string, string>; missing?: undefined } | { missing: string[] } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const missing: string[] = [];
    out[key] = String(value).replace(/\$\{(\w+)\}/g, (_, name: string) => {
      if (!source[name]) missing.push(name);
      return source[name] || "";
    });
    if (missing.length) return { missing };
  }
  return { env: out };
}

/** `mcp_<server>_<tool>`, at most 64 characters, with a hash when it had to be shortened. */
export function toolName(server: string, tool: string): string {
  const clean = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `mcp_${clean(server)}_${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = crypto.createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}
