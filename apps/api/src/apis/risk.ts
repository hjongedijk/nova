import type { Risk } from "@nova/contracts";
import type { ApiProtocol } from "./api.types.js";

const DESTRUCTIVE =
  /(destroy|delete|remove|purge|reset|format|shutdown|reboot|wipe|terminate|drop)/i;
const READ_PREFIX =
  /^(?:get|list|find|search|show|read|fetch|is|has|check|describe)/i;
const SAFE_POST_ID =
  /^(?:search|query|list|get|find|lookup|fetch|read)(?:[A-Z_\-.]|$)/;
const INTROSPECTION =
  /^(?:rpc\.discover|system\.(?:listMethods|methodHelp|methodSignature|describe))$/;

export interface ClassifyInput {
  protocol: ApiProtocol;
  method: string;
  /** operationId / field / method name. */
  name: string;
  path?: string;
  /** The spec itself said this operation does not change anything (x-readonly, x-safe). */
  readonlyHint?: boolean;
  /** The operationId came from the spec rather than being synthesised. */
  explicitId?: boolean;
}

/** The risk the engine can prove from the spec alone. The conservative default is CONFIRM. */
export function classify(input: ClassifyInput): Risk {
  const method = input.method.toUpperCase();
  const names = `${input.name} ${input.path ?? ""}`;
  if (input.protocol === "rest") {
    if (method === "DELETE") return "DANGEROUS";
    if (method === "GET" || method === "HEAD" || method === "OPTIONS")
      return DESTRUCTIVE.test(input.name) && !READ_PREFIX.test(input.name)
        ? "DANGEROUS"
        : "READ_ONLY";
    if (DESTRUCTIVE.test(names)) return "DANGEROUS";
    if (
      method === "POST" &&
      (input.readonlyHint ||
        (input.explicitId && SAFE_POST_ID.test(input.name)))
    )
      return "READ_ONLY";
    return "CONFIRM";
  }
  if (input.protocol === "graphql") {
    if (method === "QUERY") return "READ_ONLY";
    return DESTRUCTIVE.test(input.name) ? "DANGEROUS" : "CONFIRM";
  }
  if (INTROSPECTION.test(input.name)) return "READ_ONLY";
  if (DESTRUCTIVE.test(input.name)) return "DANGEROUS";
  return input.readonlyHint ? "READ_ONLY" : "CONFIRM";
}
