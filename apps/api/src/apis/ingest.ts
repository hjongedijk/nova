import type { ApiOperation, ApiProtocol, AuthHint } from "./api.types.js";
import {
  looksLikeIntrospection,
  parseGraphqlIntrospection,
} from "./graphql.js";
import {
  looksLikeHar,
  looksLikePostman,
  parseCurl,
  parseHar,
  parsePostman,
  parseRouteLines,
  type FoundSecret,
} from "./import.js";
import { parseMethodList, parseOpenRpc } from "./jsonrpc.js";
import { looksLikeOpenApi, parseOpenApi } from "./openapi.js";
import { looksLikeWsdl, parseWsdl } from "./wsdl.js";

export interface IngestOutcome {
  kind: string;
  protocol: ApiProtocol;
  baseUrl?: string;
  operations: ApiOperation[];
  secrets: FoundSecret[];
  auth?: AuthHint;
  notes: string[];
}

/** User-provided material (spec, collection, HAR, WSDL, curl, route list) -> declarative operations. Deterministic; no model. */
export function ingestDocs(
  text: string,
  base: URL | null,
): IngestOutcome | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^curl\s/i.test(trimmed) || /^\s*curl\s/m.test(trimmed)) {
    const commands = trimmed
      .split(/\n\s*(?=curl\s)/)
      .filter((c) => /^\s*curl\s/.test(c));
    const results = commands
      .map((c) => parseCurl(c))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (results.length) {
      const taken = new Set<string>();
      const operations = results
        .flatMap((r) => r.operations)
        .map((op) => {
          let id = op.id;
          for (let n = 2; taken.has(id); n++) id = `${op.id}_${n}`;
          taken.add(id);
          return { ...op, id };
        });
      return {
        kind: "curl",
        protocol: "rest",
        baseUrl: results[0]!.baseUrl,
        operations,
        secrets: results.flatMap((r) => r.secrets),
        notes: [],
      };
    }
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (looksLikeOpenApi(doc)) {
      const parsed = parseOpenApi(doc, base);
      return {
        kind: "openapi",
        protocol: "rest",
        baseUrl: parsed.serverBase,
        operations: parsed.operations,
        secrets: [],
        auth: parsed.auth,
        notes: parsed.notes,
      };
    }
    if (looksLikePostman(doc))
      return { kind: "postman", protocol: "rest", ...parsePostman(doc) };
    if (looksLikeHar(doc))
      return { kind: "har", protocol: "rest", ...parseHar(doc, base?.origin) };
    if (looksLikeIntrospection(doc)) {
      const parsed = parseGraphqlIntrospection(doc);
      return {
        kind: "graphql",
        protocol: "graphql",
        operations: parsed.operations,
        secrets: [],
        notes: parsed.notes,
      };
    }
    const methods = doc as {
      methods?: unknown;
      result?: { methods?: unknown };
    };
    if (
      Array.isArray(methods.methods) ||
      Array.isArray(methods.result?.methods)
    )
      return {
        kind: "openrpc",
        protocol: "jsonrpc",
        operations: parseOpenRpc(doc),
        secrets: [],
        notes: [],
      };
    if (Array.isArray((doc as { result?: unknown }).result))
      return {
        kind: "jsonrpc method list",
        protocol: "jsonrpc",
        operations: parseMethodList(doc),
        secrets: [],
        notes: [],
      };
    return null;
  }
  if (looksLikeWsdl(trimmed)) {
    const parsed = parseWsdl(trimmed);
    if (parsed?.operations.length)
      return {
        kind: "wsdl",
        protocol: "soap",
        baseUrl: parsed.endpoint,
        operations: parsed.operations,
        secrets: [],
        notes: parsed.notes,
      };
  }
  const routes = parseRouteLines(trimmed);
  return routes ? { kind: "route lines", protocol: "rest", ...routes } : null;
}
