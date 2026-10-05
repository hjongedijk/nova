import type { ArgumentSchema } from "@nova/contracts";

type Rule = { type?: string | string[]; enum?: unknown[] };

/*
 * Models fill optional arguments with "" or null, send numbers as text and add fields the tool
 * never asked for. None of that changes what they mean, so it is cleaned up before validation
 * instead of failing the whole request. A number under an id-like name (vmid 104) is kept, because
 * dropping it would change what is asked.
 */
const IDENTIFIER_KEY =
  /(?:^|_)(?:id|ids|vmid|ctid|vm|ct|node|entity|host|port|name)$|^(?:id|vm|ct|node|entity|host)/i;

export function coerceArguments(
  parameters: ArgumentSchema,
  args: unknown,
): unknown {
  if (args == null && !(parameters.required ?? []).length) return {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const properties = (parameters.properties ?? {}) as Record<string, Rule>;
  const required = new Set(parameters.required ?? []);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const rule = properties[key];
    if (!rule) {
      if (parameters.additionalProperties !== false) clean[key] = value;
      else if (
        (typeof value === "number" || /^\d+$/.test(String(value))) &&
        IDENTIFIER_KEY.test(key)
      )
        clean[key] = value;
      continue;
    }
    if ((value === null || value === "") && !required.has(key)) continue;
    if (
      (rule.type === "integer" || rule.type === "number") &&
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      clean[key] = Number(value);
      continue;
    }
    if (
      rule.type === "integer" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      !Number.isInteger(value)
    ) {
      clean[key] = Math.round(value);
      continue;
    }
    if (
      rule.type === "boolean" &&
      typeof value === "string" &&
      /^(?:true|false)$/i.test(value)
    ) {
      clean[key] = value.toLowerCase() === "true";
      continue;
    }
    if (rule.enum && typeof value === "string" && !rule.enum.includes(value)) {
      const match = rule.enum.find(
        (item) => String(item).toLowerCase() === value.trim().toLowerCase(),
      );
      if (match !== undefined) {
        clean[key] = match;
        continue;
      }
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * OmniRoute's Gemini schema adapter adds a required `reason` to empty object schemas. It is
 * transport metadata, not an argument.
 */
export function dropTransportReason(
  parameters: ArgumentSchema,
  args: unknown,
): unknown {
  if (
    parameters.additionalProperties === false &&
    Object.keys(parameters.properties ?? {}).length === 0 &&
    !(parameters.required ?? []).length &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length === 1 &&
    Object.hasOwn(args, "reason") &&
    typeof (args as { reason: unknown }).reason === "string"
  )
    return {};
  return args;
}

/** Arguments as the model sent them (JSON text or an object), or null when they are not an object. */
export function parseToolArguments(
  raw: unknown,
): Record<string, unknown> | null {
  try {
    const value: unknown =
      typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
