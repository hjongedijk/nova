import type { ApiOperation, ApiParam } from "./api.types.js";
import { classify } from "./risk.js";
import { cleanSchema, newOperation, oneLine, uniqueId } from "./spec-util.js";

export const INTROSPECTION_QUERY = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { kind name description fields(includeDeprecated: true) { name description isDeprecated args { name description type { ...T } } type { ...T } } inputFields { name type { ...T } } enumValues { name } } } }
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}
interface GField {
  name: string;
  description?: string;
  isDeprecated?: boolean;
  args?: { name: string; type: TypeRef }[];
  type: TypeRef;
}
interface GType {
  kind: string;
  name: string;
  fields?: GField[] | null;
  inputFields?: { name: string; type: TypeRef }[] | null;
  enumValues?: { name: string }[] | null;
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const SCALARS: Record<string, string> = {
  Int: "integer",
  Float: "number",
  Boolean: "boolean",
  String: "string",
  ID: "string",
};

export function typeString(ref: TypeRef | null | undefined): string {
  if (!ref) return "String";
  if (ref.kind === "NON_NULL") return `${typeString(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeString(ref.ofType)}]`;
  return ref.name ?? "String";
}
const named = (ref: TypeRef | null | undefined): string | null => {
  let current = ref;
  while (current && !current.name) current = current.ofType;
  return current?.name ?? null;
};
const isRequired = (ref: TypeRef) => ref.kind === "NON_NULL";

export function looksLikeIntrospection(doc: unknown): boolean {
  const schema =
    (doc as { data?: { __schema?: unknown } } | undefined)?.data?.__schema ??
    (doc as { __schema?: unknown } | undefined)?.__schema;
  return Boolean(schema && typeof schema === "object");
}

export function parseGraphqlIntrospection(doc: unknown): {
  operations: ApiOperation[];
  notes: string[];
} {
  const schema = ((doc as { data?: { __schema?: unknown } }).data?.__schema ??
    (doc as { __schema?: unknown }).__schema) as {
    queryType?: { name: string } | null;
    mutationType?: { name: string } | null;
    types: GType[];
  };
  const types = new Map(schema.types.map((type) => [type.name, type]));
  const notes: string[] = [];

  const schemaFor = (
    ref: TypeRef | null | undefined,
    depth = 0,
  ): Record<string, unknown> => {
    if (!ref) return {};
    if (ref.kind === "NON_NULL") return schemaFor(ref.ofType, depth);
    if (ref.kind === "LIST")
      return { type: "array", items: schemaFor(ref.ofType, depth + 1) };
    const type = ref.name ?? "";
    if (SCALARS[type]) return { type: SCALARS[type] };
    const def = types.get(type);
    if (def?.kind === "ENUM")
      return {
        type: "string",
        enum: (def.enumValues ?? []).map((v) => v.name),
      };
    if (def?.kind === "INPUT_OBJECT" && depth < 2)
      return {
        type: "object",
        properties: Object.fromEntries(
          (def.inputFields ?? [])
            .slice(0, 30)
            .map((f) => [f.name, schemaFor(f.type, depth + 1)]),
        ),
        required: (def.inputFields ?? [])
          .filter((f) => isRequired(f.type))
          .map((f) => f.name),
      };
    return { type: "string", description: `custom scalar ${type}` };
  };

  const selection = (typeName: string | null, depth: number): string => {
    const def = typeName ? types.get(typeName) : undefined;
    if (!def || !def.fields) return "";
    const parts: string[] = [];
    for (const field of def.fields.slice(0, 40)) {
      if (
        !NAME.test(field.name) ||
        field.name.startsWith("__") ||
        (field.args ?? []).some((a) => isRequired(a.type))
      )
        continue;
      const target = named(field.type);
      const targetDef = target ? types.get(target) : undefined;
      if (
        !targetDef ||
        targetDef.kind === "SCALAR" ||
        targetDef.kind === "ENUM"
      )
        parts.push(field.name);
      else if (
        depth > 0 &&
        (targetDef.kind === "OBJECT" || targetDef.kind === "INTERFACE")
      ) {
        const inner = selection(target, depth - 1);
        if (inner) parts.push(`${field.name} ${inner}`);
      }
    }
    return parts.length ? `{ ${parts.join(" ")} }` : "{ __typename }";
  };

  const operations: ApiOperation[] = [];
  const taken = new Set<string>();
  for (const [rootName, kind] of [
    [schema.queryType?.name, "query"],
    [schema.mutationType?.name, "mutation"],
  ] as const) {
    const root = rootName ? types.get(rootName) : undefined;
    for (const field of root?.fields ?? []) {
      if (!NAME.test(field.name) || field.name.startsWith("__")) continue;
      const args = (field.args ?? []).filter((arg) => NAME.test(arg.name));
      const target = named(field.type);
      const targetDef = target ? types.get(target) : undefined;
      const leaf =
        !targetDef || targetDef.kind === "SCALAR" || targetDef.kind === "ENUM";
      const params: ApiParam[] = args.map((arg) => ({
        name: arg.name,
        in: "arg",
        required: isRequired(arg.type),
        schema: cleanSchema(schemaFor(arg.type)),
      }));
      const id = uniqueId(
        `${kind === "query" ? "q" : "m"}_${field.name}`,
        taken,
      );
      operations.push(
        newOperation({
          id,
          summary: oneLine(field.description || `${kind} ${field.name}`),
          method: kind,
          path: field.name,
          params,
          risk: classify({
            protocol: "graphql",
            method: kind,
            name: field.name,
          }),
          status: field.isDeprecated ? "deprecated" : "ok",
          hints: field.isDeprecated ? ["deprecated in the schema"] : [],
          gql: {
            kind,
            args: args.map((arg) => ({
              name: arg.name,
              type: typeString(arg.type),
            })),
            selection: leaf ? "" : selection(target, 2),
          },
        }),
      );
    }
  }
  if (schema.types.some((type) => type.name === "Subscription"))
    notes.push("GraphQL subscriptions (WebSocket) are not supported.");
  return { operations, notes };
}
