import type { ApiIntegration, ApiOperation, ApiParam } from "./api.types.js";
import { escapeXml, parseXml } from "./xml.js";
import { pick } from "./spec-util.js";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export class AdapterError extends Error {}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const TYPE = /^[[\]!_0-9A-Za-z]+$/;
const XML_NAME = /^[A-Za-z_][\w.-]*$/;
const wire = (param: ApiParam) => param.wire ?? param.name;

function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const url = new URL(
    `${base.pathname.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    base.origin,
  );
  if (url.origin !== base.origin)
    throw new AdapterError("The operation path points outside the API host.");
  return url.toString();
}

function scalar(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
}

/** Missing required parameters, by name. */
export function missingParams(
  op: ApiOperation,
  args: Record<string, unknown>,
): string[] {
  const missing = op.params
    .filter((p) => p.required && args[p.name] === undefined)
    .map((p) => p.name);
  if (op.body?.required && args.body === undefined) missing.push("body");
  return missing;
}

/** Declarative operation + arguments -> one request. Pure; credentials are added by the caller. */
export function buildRequest(
  integration: ApiIntegration,
  op: ApiOperation,
  args: Record<string, unknown>,
): BuiltRequest {
  switch (integration.protocol) {
    case "rest":
      return buildRest(integration, op, args);
    case "graphql":
      return buildGraphql(integration, op, args);
    case "soap":
      return buildSoap(integration, op, args);
    case "jsonrpc":
      return buildJsonRpc(integration, op, args);
  }
}

function buildRest(
  integration: ApiIntegration,
  op: ApiOperation,
  args: Record<string, unknown>,
): BuiltRequest {
  let path = op.path;
  const query: [string, string][] = [];
  const headers: Record<string, string> = {};
  for (const param of op.params) {
    const value = args[param.name];
    if (value === undefined || value === null) continue;
    if (param.in === "path")
      path = path.replaceAll(
        `{${wire(param)}}`,
        encodeURIComponent(scalar(value)),
      );
    else if (param.in === "query")
      for (const item of Array.isArray(value) ? value : [value])
        query.push([wire(param), scalar(item)]);
    else if (param.in === "header" && /^[\w-]{1,60}$/.test(wire(param)))
      headers[wire(param).toLowerCase()] = scalar(value).replace(
        /[\r\n]/g,
        " ",
      );
  }
  if (/\{[^}]+\}/.test(path))
    throw new AdapterError("A path parameter is missing.");
  const url = new URL(joinUrl(integration.baseUrl, path));
  for (const [key, value] of query) url.searchParams.append(key, value);
  let body: string | undefined;
  if (
    op.body &&
    args.body !== undefined &&
    !["GET", "HEAD"].includes(op.method)
  ) {
    if (
      /x-www-form-urlencoded/i.test(op.body.contentType) &&
      typeof args.body === "object" &&
      args.body
    )
      body = new URLSearchParams(
        Object.entries(args.body as Record<string, unknown>).map(
          ([k, v]): [string, string] => [k, scalar(v)],
        ),
      ).toString();
    else
      body =
        typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    headers["content-type"] = op.body.contentType;
  }
  return {
    url: url.toString(),
    method: op.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

function buildGraphql(
  integration: ApiIntegration,
  op: ApiOperation,
  args: Record<string, unknown>,
): BuiltRequest {
  const gql = op.gql;
  if (!gql || !NAME.test(op.path))
    throw new AdapterError("This GraphQL operation is not callable.");
  const used = gql.args.filter(
    (a) => NAME.test(a.name) && TYPE.test(a.type) && args[a.name] !== undefined,
  );
  const variables = Object.fromEntries(used.map((a) => [a.name, args[a.name]]));
  const decl = used.length
    ? `(${used.map((a) => `$${a.name}: ${a.type}`).join(", ")})`
    : "";
  const call = used.length
    ? `(${used.map((a) => `${a.name}: $${a.name}`).join(", ")})`
    : "";
  const query = `${gql.kind} Nova${decl} { ${op.path}${call} ${gql.selection} }`;
  return {
    url: integration.baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
}

function buildSoap(
  integration: ApiIntegration,
  op: ApiOperation,
  args: Record<string, unknown>,
): BuiltRequest {
  const soap = op.soap;
  if (!soap || !XML_NAME.test(soap.element))
    throw new AdapterError("This SOAP operation is not callable.");
  const inner = op.params
    .filter((p) => XML_NAME.test(p.name) && args[p.name] !== undefined)
    .map((p) => `<${p.name}>${escapeXml(scalar(args[p.name]))}</${p.name}>`)
    .join("");
  const ns = soap.namespace ? ` xmlns="${escapeXml(soap.namespace)}"` : "";
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${soap.element}${ns}>${inner}</${soap.element}></soap:Body></soap:Envelope>`;
  return {
    url: integration.baseUrl,
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: `"${soap.action.replace(/["\r\n]/g, "")}"`,
    },
    body,
  };
}

let rpcId = 0;
function buildJsonRpc(
  integration: ApiIntegration,
  op: ApiOperation,
  args: Record<string, unknown>,
): BuiltRequest {
  const named = op.params.length === 1 && op.params[0]!.name === "params";
  const params = named
    ? args.params
    : Object.fromEntries(
        op.params
          .filter((p) => args[p.name] !== undefined)
          .map((p) => [wire(p), args[p.name]]),
      );
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: op.path,
  };
  if (
    params !== undefined &&
    !(
      typeof params === "object" &&
      params &&
      !Array.isArray(params) &&
      !Object.keys(params).length
    )
  )
    payload.params = params;
  return {
    url: integration.baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export interface Decoded {
  ok: boolean;
  data: unknown;
  error?: string;
}

/** HTTP response -> decoded data. Protocol-level errors (GraphQL errors, SOAP faults, JSON-RPC errors) become ok:false. */
export function decodeResponse(
  integration: ApiIntegration,
  op: ApiOperation,
  status: number,
  contentType: string,
  body: string,
): Decoded {
  const httpOk = status >= 200 && status < 300;
  const json = (): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  };
  if (integration.protocol === "graphql") {
    const doc = json() as
      { data?: unknown; errors?: { message?: string }[] } | undefined;
    if (doc?.errors?.length && (doc.data === null || doc.data === undefined))
      return {
        ok: false,
        data: doc,
        error: `GraphQL error: ${String(doc.errors[0]?.message ?? "unknown").slice(0, 200)}`,
      };
    if (doc && "data" in doc)
      return { ok: httpOk, data: pick(doc.data, op.path) };
  }
  if (integration.protocol === "jsonrpc") {
    const doc = json() as
      | { result?: unknown; error?: { code?: number; message?: string } }
      | undefined;
    if (doc?.error)
      return {
        ok: false,
        data: doc.error,
        error: `JSON-RPC error ${doc.error.code ?? ""}: ${String(doc.error.message ?? "").slice(0, 200)}`,
      };
    if (doc && "result" in doc) return { ok: httpOk, data: doc.result };
  }
  if (integration.protocol === "soap" || /xml/i.test(contentType)) {
    const parsed = parseXml(body);
    const envelope = parsed?.Envelope as Record<string, unknown> | undefined;
    const soapBody = envelope?.Body as Record<string, unknown> | undefined;
    if (soapBody?.Fault) {
      const fault = soapBody.Fault as Record<string, unknown>;
      return {
        ok: false,
        data: fault,
        error: `SOAP fault: ${String(fault.faultstring ?? (fault.Reason as Record<string, unknown> | undefined)?.Text ?? "unknown").slice(0, 200)}`,
      };
    }
    if (soapBody) {
      const first = Object.values(soapBody)[0];
      return { ok: httpOk, data: first };
    }
    return { ok: httpOk, data: parsed ?? body };
  }
  const parsed = json();
  return {
    ok: httpOk,
    data: pick(parsed !== undefined ? parsed : body, op.responsePath),
    ...(httpOk ? {} : { error: `HTTP ${status}` }),
  };
}
