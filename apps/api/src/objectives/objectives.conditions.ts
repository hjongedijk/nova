import type { Condition, Operator } from "./objectives.types.js";

interface Hit {
  value: unknown;
  /** The array element the value belongs to, to name what is wrong ("pve1", "api"). */
  owner: unknown;
}

const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/** Walk `a.b[].c`; `[]` fans out over an array. Missing or odd shapes yield no hits. */
export function resolve(root: unknown, path: string): Hit[] {
  let hits: Hit[] = [{ value: root, owner: root }];
  for (const segment of path.split(".")) {
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    if (BLOCKED.has(key)) return [];
    const next: Hit[] = [];
    for (const hit of hits) {
      let value = hit.value;
      if (key) {
        if (
          !value ||
          typeof value !== "object" ||
          !Object.hasOwn(value as object, key)
        )
          continue;
        value = (value as Record<string, unknown>)[key];
      }
      if (each) {
        if (!Array.isArray(value)) continue;
        for (const item of value) next.push({ value: item, owner: item });
      } else next.push({ value, owner: hit.owner });
    }
    hits = next;
  }
  return hits;
}

function holds(actual: unknown, op: Operator, expected: unknown): boolean {
  if (typeof expected === "number") {
    if (actual === null || actual === "" || typeof actual === "boolean")
      return false;
    const n = Number(actual);
    if (!Number.isFinite(n)) return false;
    switch (op) {
      case ">":
        return n > expected;
      case "<":
        return n < expected;
      case ">=":
        return n >= expected;
      case "<=":
        return n <= expected;
      case "==":
        return n === expected;
      case "!=":
        return n !== expected;
    }
  }
  const same =
    typeof expected === "boolean"
      ? actual === expected
      : typeof actual !== "object" &&
        String(actual).toLowerCase() === String(expected).toLowerCase();
  if (op === "==") return same;
  if (op === "!=") return !same;
  return false;
}

function nameOf(owner: unknown): string {
  if (owner && typeof owner === "object") {
    const o = owner as Record<string, unknown>;
    for (const key of ["name", "node", "entity_id", "vmid"])
      if (typeof o[key] === "string" || typeof o[key] === "number")
        return String(o[key]).slice(0, 40);
  }
  return "";
}

export interface Evaluation {
  anomaly: boolean;
  detail: string;
}

/** Deterministic, model-free: does the anomaly condition hold for this tool result? */
export function evaluate(condition: Condition, result: unknown): Evaluation {
  const hits = resolve(result, condition.path);
  if (condition.kind === "empty" || condition.kind === "not_empty") {
    const list = hits[0]?.value;
    const empty = Array.isArray(list) ? list.length === 0 : hits.length === 0;
    const anomaly = condition.kind === "empty" ? empty : !empty;
    return {
      anomaly,
      detail: anomaly
        ? condition.kind === "empty"
          ? `${condition.path} is leeg`
          : `${condition.path} bevat ${Array.isArray(list) ? list.length : "iets"}`
        : "",
    };
  }
  const bad = hits.filter((h) => holds(h.value, condition.op, condition.value));
  if (!bad.length) return { anomaly: false, detail: "" };
  const parts = bad.slice(0, 3).map((h) => {
    const who = nameOf(h.owner);
    return `${who ? `${who}: ` : ""}${String(h.value).slice(0, 40)}`;
  });
  return {
    anomaly: true,
    detail: `${parts.join(", ")}${bad.length > 3 ? ` (+${bad.length - 3})` : ""}`,
  };
}
