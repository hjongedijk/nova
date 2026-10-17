import crypto from "node:crypto";
import type { ApiOperation } from "./api.types.js";

export const MAX_OPERATIONS = 400;

export function slug(value: string, max = 24): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "x"
  );
}

export function operationId(value: string, max = 40): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "op"
  );
}

/** Text from a remote spec ends up in the model's tool list: one short plain line, no control characters. */
export function oneLine(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/[<>`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
}

const SCHEMA_KEYS = [
  "type",
  "enum",
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "default",
  "required",
  "nullable",
];

/** A small, self-contained JSON schema: no $ref, no remote references, bounded depth and size. */
export function cleanSchema(
  input: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || depth > 4)
    return {};
  const source = input as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...source };
  if (Array.isArray(source.allOf))
    for (const part of source.allOf as unknown[])
      if (part && typeof part === "object")
        Object.assign(merged, part, { ...merged });
  const alternative = [source.oneOf, source.anyOf].find(Array.isArray) as
    unknown[] | undefined;
  if (alternative?.[0] && typeof alternative[0] === "object" && !merged.type)
    Object.assign(merged, alternative[0]);
  const out: Record<string, unknown> = {};
  for (const key of SCHEMA_KEYS)
    if (merged[key] !== undefined) out[key] = merged[key];
  if (typeof out.description === "string")
    out.description = oneLine(out.description, 120);
  else delete out.description;
  if (Array.isArray(out.enum))
    out.enum = (out.enum as unknown[])
      .slice(0, 40)
      .filter((item) => ["string", "number", "boolean"].includes(typeof item));
  if (!Array.isArray(out.enum) || !(out.enum as unknown[]).length)
    delete out.enum;
  if (
    typeof out.type === "string" &&
    !["string", "number", "integer", "boolean", "array", "object"].includes(
      out.type,
    )
  )
    delete out.type;
  if (Array.isArray(out.type))
    out.type =
      (out.type as unknown[]).find((item) => item !== "null") ?? "string";
  if (
    !Array.isArray(out.required) ||
    typeof (out.required as unknown[])[0] !== "string"
  )
    delete out.required;
  if (typeof out.nullable !== "boolean") delete out.nullable;
  delete out.nullable;
  if (merged.items) out.items = cleanSchema(merged.items, depth + 1);
  if (out.type === "array" && !out.items) out.items = {};
  const properties = merged.properties;
  if (properties && typeof properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, value]) => [key, cleanSchema(value, depth + 1)]),
    );
    out.type ??= "object";
  }
  if (Array.isArray(out.required) && out.properties)
    out.required = (out.required as string[]).filter(
      (name) => name in (out.properties as object),
    );
  else if (out.type === "object") delete out.required;
  return out;
}

/** Fingerprint of everything that defines how an operation is called (not its stats or status). */
export function operationHash(
  op: Pick<
    ApiOperation,
    "method" | "path" | "params" | "body" | "gql" | "soap"
  >,
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        op.method,
        op.path,
        op.params.map((p) => [p.name, p.wire, p.in, p.required, p.schema.type]),
        op.body
          ? [
              op.body.contentType,
              op.body.required,
              Object.keys((op.body.schema.properties as object) ?? {}),
            ]
          : null,
        op.gql ?? null,
        op.soap ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export function newOperation(
  fields: Omit<
    ApiOperation,
    "hash" | "stats" | "status" | "enabled" | "routine" | "floor" | "hints"
  > &
    Partial<Pick<ApiOperation, "status" | "hints" | "enabled">>,
): ApiOperation {
  const base = {
    ...fields,
    floor: fields.risk,
    routine:
      fields.method.toUpperCase() === "GET" && fields.risk === "READ_ONLY",
    enabled: fields.enabled ?? true,
    status: fields.status ?? ("ok" as const),
    hints: fields.hints ?? [],
    stats: { ok: 0, fail: 0, failStreak: 0 },
  };
  return { ...base, hash: operationHash(base) };
}

export function uniqueId(wanted: string, taken: Set<string>): string {
  let id = wanted;
  let n = 2;
  while (taken.has(id)) id = `${wanted}_${n++}`;
  taken.add(id);
  return id;
}

/** Walk a dotted path (a.b.0.c) in decoded data. */
export function pick(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return data;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? data : current;
}
