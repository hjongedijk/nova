import type { ApiOperation, ApiParam } from "./api.types.js";
import { classify } from "./risk.js";
import {
  cleanSchema,
  newOperation,
  oneLine,
  operationId,
  uniqueId,
} from "./spec-util.js";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

/** A credential found in user-provided material. It goes to the vault at once and never into a spec. */
export interface FoundSecret {
  kind: "bearer" | "basic" | "header" | "query";
  name?: string;
  value: string;
}

export interface ImportResult {
  baseUrl?: string;
  operations: ApiOperation[];
  secrets: FoundSecret[];
  notes: string[];
}

const SECRET_HEADER =
  /^(authorization|x-api-key|api-key|apikey|x-auth-token|x-token|proxy-authorization)$/i;
const SECRET_QUERY =
  /^(api[_-]?key|apikey|access[_-]?token|token|key|auth|secret)$/i;

function secretFromHeader(name: string, value: string): FoundSecret | null {
  if (!SECRET_HEADER.test(name)) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  if (bearer) return { kind: "bearer", value: bearer[1]!.trim() };
  const basic = /^Basic\s+(.+)$/i.exec(value);
  if (basic) {
    try {
      return {
        kind: "basic",
        value: Buffer.from(basic[1]!, "base64").toString("utf8"),
      };
    } catch {
      return null;
    }
  }
  return { kind: "header", name, value };
}

/** Shell-like split honouring single/double quotes and backslash-newline continuations. */
export function shellSplit(command: string): string[] {
  const text = command.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length)
        current += text[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
    } else if (c === "\\" && i + 1 < text.length) current += text[++i];
    else current += c;
  }
  if (started || current) out.push(current);
  return out;
}

function splitUrl(
  raw: string,
): { base: string; path: string; query: [string, string][] } | null {
  try {
    const url = new URL(raw);
    return {
      base: url.origin,
      path: url.pathname,
      query: [...url.searchParams.entries()],
    };
  } catch {
    return null;
  }
}

function operationFromRequest(
  method: string,
  path: string,
  query: [string, string][],
  body: string | undefined,
  contentType: string | undefined,
  taken: Set<string>,
  secrets: FoundSecret[],
  label?: string,
): ApiOperation {
  const params: ApiParam[] = [];
  const names = new Set<string>();
  const templated = path.replace(
    /\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,})(?=\/|$)/gi,
    (_m, _v, offset: number) => {
      let name =
        `${/([A-Za-z]+)\/$/.exec(path.slice(0, offset + 1))?.[1] ?? "id"}_id`.toLowerCase();
      while (names.has(name)) name += "_";
      names.add(name);
      params.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
      return `/{${name}}`;
    },
  );
  for (const [key, value] of query) {
    if (SECRET_QUERY.test(key)) {
      secrets.push({ kind: "query", name: key, value });
      continue;
    }
    if (names.has(key)) continue;
    names.add(key);
    params.push({
      name: key.replace(/[^A-Za-z0-9_.-]/g, "_"),
      ...(/[^A-Za-z0-9_.-]/.test(key) ? { wire: key } : {}),
      in: "query",
      required: false,
      schema: { type: "string" },
      description: `example: ${oneLine(value, 30)}`,
    });
  }
  let bodySpec: ApiOperation["body"];
  if (body && method !== "GET") {
    let schema: Record<string, unknown> = { type: "string" };
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object")
        schema = cleanSchema({
          type: Array.isArray(parsed) ? "array" : "object",
          properties: Array.isArray(parsed)
            ? undefined
            : Object.fromEntries(
                Object.entries(parsed as Json).map(([k, v]) => [
                  k,
                  {
                    type:
                      typeof v === "number"
                        ? "number"
                        : typeof v === "boolean"
                          ? "boolean"
                          : typeof v === "object"
                            ? "object"
                            : "string",
                  },
                ]),
              ),
          items: Array.isArray(parsed) ? {} : undefined,
        });
    } catch {
      /* not JSON */
    }
    bodySpec = {
      contentType: contentType ?? "application/json",
      schema,
      required: true,
    };
  }
  const id = uniqueId(operationId(label ?? `${method}_${templated}`), taken);
  const upper = method.toUpperCase();
  return newOperation({
    id,
    summary: oneLine(label ?? `${upper} ${templated}`),
    method: upper,
    path: templated,
    params,
    ...(bodySpec ? { body: bodySpec } : {}),
    risk: classify({
      protocol: "rest",
      method: upper,
      name: id,
      path: templated,
    }),
    hints: ["learned from an example, not from a spec"],
  });
}

export function parseCurl(command: string): ImportResult | null {
  const tokens = shellSplit(command.trim());
  if (tokens[0] !== "curl") return null;
  let method = "";
  let url = "";
  let body: string | undefined;
  let contentType: string | undefined;
  const secrets: FoundSecret[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = () => tokens[++i] ?? "";
    if (t === "-X" || t === "--request") method = next().toUpperCase();
    else if (t === "-H" || t === "--header") {
      const header = next();
      const at = header.indexOf(":");
      if (at < 1) continue;
      const name = header.slice(0, at).trim();
      const value = header.slice(at + 1).trim();
      const secret = secretFromHeader(name, value);
      if (secret) secrets.push(secret);
      else if (/^content-type$/i.test(name)) contentType = value;
    } else if (
      [
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
      ].includes(t)
    )
      body = next();
    else if (t === "-u" || t === "--user")
      secrets.push({ kind: "basic", value: next() });
    else if (t === "--url") url = next();
    else if (t === "-G" || t === "--get") method = "GET";
    else if (/^https?:\/\//i.test(t)) url = t;
    else if (
      [
        "-o",
        "--output",
        "-m",
        "--max-time",
        "-A",
        "--user-agent",
        "-e",
        "--referer",
        "-b",
        "--cookie",
      ].includes(t)
    )
      next();
  }
  const parts = splitUrl(url);
  if (!parts) return null;
  const taken = new Set<string>();
  const op = operationFromRequest(
    method || (body ? "POST" : "GET"),
    parts.path,
    parts.query,
    body,
    contentType,
    taken,
    secrets,
  );
  return { baseUrl: parts.base, operations: [op], secrets, notes: [] };
}

function postmanUrl(url: unknown, variables: Record<string, string>): string {
  const raw = typeof url === "string" ? url : String(obj(url).raw ?? "");
  return raw.replace(
    /\{\{([^}]+)\}\}/g,
    (match, name: string, offset: number) =>
      variables[name.trim()] ?? (offset === 0 ? match : `{${name.trim()}}`),
  );
}

export function looksLikePostman(doc: unknown): boolean {
  return (
    Array.isArray(obj(doc).item) &&
    typeof obj(obj(doc).info).schema === "string" &&
    /postman/i.test(String(obj(obj(doc).info).schema))
  );
}

export function parsePostman(doc: unknown): ImportResult {
  const root = obj(doc);
  const variables: Record<string, string> = {};
  for (const v of Array.isArray(root.variable) ? root.variable : []) {
    const vv = obj(v);
    if (typeof vv.key === "string") variables[vv.key] = String(vv.value ?? "");
  }
  const secrets: FoundSecret[] = [];
  const notes: string[] = [];
  const auth = obj(root.auth);
  const authValue = (kind: string, key: string): string | undefined => {
    const entry = (Array.isArray(auth[kind]) ? (auth[kind] as unknown[]) : [])
      .map(obj)
      .find((e) => e.key === key);
    return typeof entry?.value === "string" ? entry.value : undefined;
  };
  if (auth.type === "bearer") {
    const token = authValue("bearer", "token");
    if (token && !token.startsWith("{{"))
      secrets.push({ kind: "bearer", value: token });
  } else if (auth.type === "basic") {
    const user = authValue("basic", "username");
    const pass = authValue("basic", "password");
    if (user && pass) secrets.push({ kind: "basic", value: `${user}:${pass}` });
  } else if (auth.type === "apikey") {
    const key = authValue("apikey", "key");
    const value = authValue("apikey", "value");
    if (key && value)
      secrets.push({
        kind: authValue("apikey", "in") === "query" ? "query" : "header",
        name: key,
        value,
      });
  }
  const operations: ApiOperation[] = [];
  const taken = new Set<string>();
  let baseUrl: string | undefined;
  const walk = (items: unknown[], depth: number) => {
    for (const raw of items) {
      const item = obj(raw);
      if (Array.isArray(item.item) && depth < 6) walk(item.item, depth + 1);
      const request = obj(item.request);
      if (!request.method || operations.length >= 400) continue;
      const parts = splitUrl(postmanUrl(request.url, variables));
      if (!parts) {
        notes.push(
          `Skipped '${oneLine(item.name, 40)}': the URL contains an unresolved variable. Add a 'variable' for the base URL.`,
        );
        continue;
      }
      baseUrl ??= parts.base;
      if (parts.base !== baseUrl) continue;
      let contentType: string | undefined;
      for (const h of Array.isArray(request.header) ? request.header : []) {
        const hh = obj(h);
        const name = String(hh.key ?? "");
        const secret = secretFromHeader(name, String(hh.value ?? ""));
        if (secret) secrets.push(secret);
        else if (/^content-type$/i.test(name)) contentType = String(hh.value);
      }
      const body = obj(request.body);
      operations.push(
        operationFromRequest(
          String(request.method),
          parts.path,
          parts.query,
          typeof body.raw === "string" ? body.raw : undefined,
          contentType,
          taken,
          secrets,
          typeof item.name === "string" ? item.name : undefined,
        ),
      );
    }
  };
  walk(Array.isArray(root.item) ? root.item : [], 0);
  return { baseUrl, operations, secrets, notes };
}

export function looksLikeHar(doc: unknown): boolean {
  return Array.isArray(obj(obj(doc).log).entries);
}

export function parseHar(doc: unknown, onlyOrigin?: string): ImportResult {
  const entries = (obj(obj(doc).log).entries as unknown[]).map(obj);
  const secrets: FoundSecret[] = [];
  const operations: ApiOperation[] = [];
  const seen = new Set<string>();
  const taken = new Set<string>();
  let baseUrl = onlyOrigin;
  for (const entry of entries) {
    const request = obj(entry.request);
    const parts = splitUrl(String(request.url ?? ""));
    if (!parts) continue;
    const mime = String(obj(obj(entry.response).content).mimeType ?? "");
    if (/image|font|css|javascript|html/i.test(mime) && !/json|xml/i.test(mime))
      continue;
    baseUrl ??= parts.base;
    if (parts.base !== baseUrl) continue;
    const method = String(request.method ?? "GET").toUpperCase();
    const key = `${method} ${parts.path.replace(/\d+/g, "#")}`;
    for (const h of Array.isArray(request.headers) ? request.headers : []) {
      const hh = obj(h);
      const secret = secretFromHeader(
        String(hh.name ?? ""),
        String(hh.value ?? ""),
      );
      if (secret) secrets.push(secret);
    }
    if (seen.has(key) || operations.length >= 200) continue;
    seen.add(key);
    const post = obj(request.postData);
    operations.push(
      operationFromRequest(
        method,
        parts.path,
        parts.query,
        typeof post.text === "string" ? post.text : undefined,
        typeof post.mimeType === "string" ? post.mimeType : undefined,
        taken,
        secrets,
      ),
    );
  }
  return {
    baseUrl,
    operations,
    secrets,
    notes: [
      "HAR import keeps one operation per method and path pattern and skips static assets.",
    ],
  };
}

/** Lines such as `GET /v1/items/{id}` from pasted documentation. Deterministic, no guessing beyond the line itself. */
export function parseRouteLines(text: string): ImportResult | null {
  const taken = new Set<string>();
  const operations: ApiOperation[] = [];
  for (const m of text.matchAll(
    /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?#]*)(?:\?([^\s#]*))?/gim,
  )) {
    if (operations.length >= 200) break;
    const query: [string, string][] = (m[3] ?? "")
      .split("&")
      .filter(Boolean)
      .map((pair) => [pair.split("=")[0]!, ""] as [string, string]);
    const path = m[2]!.replace(/:([A-Za-z_]\w*)/g, "{$1}");
    const op = operationFromRequest(
      m[1]!.toUpperCase(),
      path,
      query,
      undefined,
      undefined,
      taken,
      [],
    );
    for (const match of path.matchAll(/\{(\w+)\}/g))
      if (!op.params.some((p) => p.name === match[1]))
        op.params.push({
          name: match[1]!,
          in: "path",
          required: true,
          schema: { type: "string" },
        });
    operations.push(op);
  }
  return operations.length
    ? {
        operations,
        secrets: [],
        notes: [
          "Operations were read from route lines in the pasted text; parameters beyond the path are unknown.",
        ],
      }
    : null;
}
