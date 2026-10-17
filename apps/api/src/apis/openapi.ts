import type { ApiOperation, ApiParam, AuthHint } from "./api.types.js";
import { classify } from "./risk.js";
import {
  MAX_OPERATIONS,
  cleanSchema,
  newOperation,
  oneLine,
  operationId,
  uniqueId,
} from "./spec-util.js";

type Json = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const asObject = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

/** Resolve local $refs with a node budget and cycle protection. */
export function deref(
  root: Json,
  node: unknown,
  budget = { left: 40_000 },
  stack: string[] = [],
): unknown {
  if (budget.left-- <= 0) return {};
  if (Array.isArray(node))
    return node.map((item) => deref(root, item, budget, stack));
  if (!node || typeof node !== "object") return node;
  const object = node as Json;
  if (typeof object.$ref === "string") {
    const ref = object.$ref;
    if (!ref.startsWith("#/") || stack.includes(ref) || stack.length > 6)
      return { type: "object" };
    let target: unknown = root;
    for (const part of ref.slice(2).split("/"))
      target = asObject(target)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(root, target, budget, [...stack, ref]);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      deref(root, value, budget, stack),
    ]),
  );
}

export function looksLikeOpenApi(doc: unknown): boolean {
  const object = asObject(doc);
  return (
    (typeof object.openapi === "string" && object.openapi.startsWith("3")) ||
    object.swagger === "2.0"
  );
}

export interface OpenApiResult {
  title: string;
  operations: ApiOperation[];
  auth: AuthHint;
  serverBase?: string;
  notes: string[];
}

function authFrom(root: Json, base: URL | null, notes: string[]): AuthHint {
  const schemes = asObject(
    asObject(root.components).securitySchemes ?? root.securityDefinitions,
  );
  const ordered = Object.values(schemes).map(asObject);
  const usedNames = new Set(
    (Array.isArray(root.security) ? (root.security as Json[]) : []).flatMap(
      (item) => Object.keys(item),
    ),
  );
  const prioritised = [
    ...Object.entries(schemes)
      .filter(([name]) => usedNames.has(name))
      .map(([, v]) => asObject(v)),
    ...ordered,
  ];
  for (const scheme of prioritised) {
    const type = String(scheme.type ?? "");
    if (type === "http" && /bearer/i.test(String(scheme.scheme)))
      return { type: "bearer" };
    if (type === "http" && /basic/i.test(String(scheme.scheme)))
      return { type: "basic" };
    if (type === "basic") return { type: "basic" };
    if (
      type === "apiKey" &&
      (scheme.in === "header" || scheme.in === "query") &&
      typeof scheme.name === "string"
    )
      return { type: scheme.in, name: scheme.name };
    if (type === "oauth2") {
      const flows = asObject(scheme.flows);
      const cc = asObject(flows.clientCredentials);
      const tokenUrl = String(
        cc.tokenUrl ??
          (scheme.flow === "application" ? scheme.tokenUrl : "") ??
          "",
      );
      if (tokenUrl) {
        try {
          const url = new URL(tokenUrl, base ?? undefined);
          if (base && url.origin === base.origin)
            return {
              type: "oauth2_client_credentials",
              tokenUrl: url.toString(),
              scope: Object.keys(asObject(cc.scopes)).join(" ") || undefined,
            };
          notes.push(
            `OAuth2 token URL is on another host (${url.host}); NOVA only sends client credentials there if you pass token_url yourself.`,
          );
        } catch {
          /* ignore */
        }
      }
      if (
        flows.authorizationCode ||
        flows.implicit ||
        scheme.flow === "accessCode" ||
        scheme.flow === "implicit"
      )
        notes.push(
          "OAuth2 authorization-code/implicit flow needs a browser login and is not automated; supply an access token as a bearer token.",
        );
    }
  }
  return { type: "unknown" };
}

export function parseOpenApi(input: unknown, base: URL | null): OpenApiResult {
  const root = asObject(input);
  const doc = deref(root, root) as Json;
  const notes: string[] = [];
  const v3 = typeof root.openapi === "string";
  const taken = new Set<string>();
  const operations: ApiOperation[] = [];
  const info = asObject(doc.info);
  let serverBase: string | undefined;
  if (v3) {
    const server = asObject((Array.isArray(doc.servers) ? doc.servers : [])[0]);
    if (typeof server.url === "string") {
      let url = server.url;
      for (const [name, variable] of Object.entries(asObject(server.variables)))
        url = url.replaceAll(
          `{${name}}`,
          String(asObject(variable).default ?? ""),
        );
      serverBase = url;
    }
  } else if (typeof doc.host === "string" || typeof doc.basePath === "string") {
    const scheme =
      (Array.isArray(doc.schemes) ? String(doc.schemes[0]) : "https") ||
      "https";
    serverBase = doc.host
      ? `${scheme}://${String(doc.host)}${String(doc.basePath ?? "")}`
      : String(doc.basePath ?? "");
  }
  if (serverBase && base) {
    try {
      const resolved = new URL(serverBase, base);
      if (resolved.origin === base.origin)
        serverBase = resolved.toString().replace(/\/$/, "");
      else {
        notes.push(
          `The spec names another server (${resolved.host}); NOVA keeps calling ${base.host} and never sends credentials elsewhere.`,
        );
        serverBase =
          `${base.origin}${resolved.pathname === "/" ? "" : resolved.pathname.replace(/\/$/, "")}` ||
          undefined;
      }
    } catch {
      serverBase = undefined;
    }
  }
  const globalConsumes = Array.isArray(doc.consumes)
    ? (doc.consumes as string[])
    : [];
  for (const [path, rawItem] of Object.entries(asObject(doc.paths))) {
    const item = asObject(rawItem);
    for (const method of METHODS) {
      if (!item[method]) continue;
      if (operations.length >= MAX_OPERATIONS) {
        notes.push(`Only the first ${MAX_OPERATIONS} operations were learned.`);
        break;
      }
      const op = asObject(item[method]);
      const explicit =
        typeof op.operationId === "string" && op.operationId.length > 0;
      const id = uniqueId(
        operationId(explicit ? String(op.operationId) : `${method}_${path}`),
        taken,
      );
      const merged = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ].map(asObject);
      const params: ApiParam[] = [];
      const names = new Set<string>();
      let body: ApiOperation["body"];
      for (const parameter of merged) {
        const where = String(parameter.in);
        const wire = String(parameter.name ?? "");
        if (!wire) continue;
        if (where === "body") {
          body = {
            contentType: "application/json",
            schema: cleanSchema(parameter.schema),
            required: parameter.required === true,
          };
          continue;
        }
        if (where === "formData") {
          const current = body ?? {
            contentType: "application/x-www-form-urlencoded",
            schema: {
              type: "object",
              properties: {} as Json,
              required: [] as string[],
            },
            required: false,
          };
          (current.schema.properties as Json)[wire] = cleanSchema(parameter);
          if (parameter.required)
            (current.schema.required as string[]).push(wire);
          body = current;
          continue;
        }
        if (!["path", "query", "header"].includes(where)) continue;
        if (
          where === "header" &&
          /^(authorization|x-api-key|api-key|cookie)$/i.test(wire)
        )
          continue;
        let name = wire.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "p";
        if (names.has(name)) name = `${name}_${where}`;
        names.add(name);
        params.push({
          name,
          ...(name !== wire ? { wire } : {}),
          in: where as ApiParam["in"],
          required: where === "path" || parameter.required === true,
          schema: cleanSchema(v3 ? parameter.schema : parameter),
          ...(parameter.description
            ? { description: oneLine(parameter.description, 100) }
            : {}),
        });
      }
      if (v3 && op.requestBody) {
        const content = asObject(asObject(op.requestBody).content);
        const type =
          Object.keys(content).find((key) => /json/i.test(key)) ??
          Object.keys(content).find((key) =>
            /x-www-form-urlencoded/i.test(key),
          ) ??
          Object.keys(content)[0];
        if (type)
          body = {
            contentType: type,
            schema: cleanSchema(asObject(content[type]).schema),
            required: asObject(op.requestBody).required === true,
          };
      } else if (body && !v3) {
        const consumes = (
          Array.isArray(op.consumes)
            ? (op.consumes as string[])
            : globalConsumes
        )[0];
        if (consumes && body.contentType === "application/json")
          body.contentType = consumes;
      }
      const readonlyHint =
        op["x-readonly"] === true ||
        op["x-safe"] === true ||
        op["x-nova-readonly"] === true;
      const risk = classify({
        protocol: "rest",
        method,
        name: id,
        path,
        readonlyHint,
        explicitId: explicit,
      });
      const deprecated = op.deprecated === true;
      operations.push(
        newOperation({
          id,
          summary: oneLine(
            op.summary || op.description || `${method.toUpperCase()} ${path}`,
          ),
          method: method.toUpperCase(),
          path,
          params,
          ...(body ? { body } : {}),
          risk,
          status: deprecated ? "deprecated" : "ok",
          hints: deprecated ? ["deprecated in the spec"] : [],
        }),
      );
    }
  }
  return {
    title: oneLine(info.title, 60) || "API",
    operations,
    auth: authFrom(doc, base, notes),
    serverBase,
    notes,
  };
}
