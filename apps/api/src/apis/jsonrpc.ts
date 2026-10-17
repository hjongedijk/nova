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

export function looksLikeJsonRpc(doc: unknown): boolean {
  const o = obj(doc);
  return (
    o.jsonrpc === "2.0" &&
    ("result" in o || typeof obj(o.error).code === "number")
  );
}

/** OpenRPC document (result of rpc.discover). */
export function parseOpenRpc(doc: unknown): ApiOperation[] {
  const result = obj(obj(doc).result ?? doc);
  const taken = new Set<string>();
  return (Array.isArray(result.methods) ? (result.methods as unknown[]) : [])
    .slice(0, 400)
    .flatMap((raw) => {
      const m = obj(raw);
      if (typeof m.name !== "string" || !/^[\w.:-]{1,80}$/.test(m.name))
        return [];
      const params: ApiParam[] = (
        Array.isArray(m.params) ? (m.params as unknown[]) : []
      ).map((p) => {
        const pp = obj(p);
        return {
          name: String(pp.name ?? "param").replace(/[^A-Za-z0-9_.-]/g, "_"),
          in: "arg" as const,
          required: pp.required === true,
          schema: cleanSchema(pp.schema),
        };
      });
      return [
        newOperation({
          id: uniqueId(operationId(m.name), taken),
          summary: oneLine(
            m.summary || m.description || `JSON-RPC method ${m.name}`,
          ),
          method: "POST",
          path: m.name,
          params,
          risk: classify({
            protocol: "jsonrpc",
            method: "POST",
            name: m.name,
            readonlyHint: m["x-readonly"] === true,
          }),
          status: m.deprecated === true ? "deprecated" : "ok",
        }),
      ];
    });
}

/** system.listMethods: names only, parameters unknown (free-form). */
export function parseMethodList(doc: unknown): ApiOperation[] {
  const list = obj(doc).result;
  const taken = new Set<string>();
  return (Array.isArray(list) ? list : []).slice(0, 400).flatMap((name) =>
    typeof name === "string" && /^[\w.:-]{1,80}$/.test(name)
      ? [
          newOperation({
            id: uniqueId(operationId(name), taken),
            summary: `JSON-RPC method ${name} (parameters unknown; pass them as 'params')`,
            method: "POST",
            path: name,
            params: [
              { name: "params", in: "arg", required: false, schema: {} },
            ],
            risk: classify({ protocol: "jsonrpc", method: "POST", name }),
            hints: ["parameters unknown: only the method name was published"],
          }),
        ]
      : [],
  );
}
