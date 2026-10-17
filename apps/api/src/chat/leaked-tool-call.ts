export interface LeakedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The reply text around the JSON, with the JSON removed. */
  rest: string;
}

/** Index of the matching closing brace for the object that starts at `start`, honouring strings; -1 when unbalanced. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Some free models write a tool call as plain text instead of a real one, for example
 * `{"type": "function", "name": "x", "parameters": {...}}`. That must never reach the user as chat text. Returns the call
 * when such a JSON object is found, otherwise null.
 */
export function findLeakedToolCall(content: string): LeakedToolCall | null {
  for (let start = content.indexOf("{"); start !== -1;) {
    const end = objectEnd(content, start);
    if (end === -1) return null;
    try {
      const outer = asObject(JSON.parse(content.slice(start, end + 1)));
      const fn = asObject(outer?.function);
      const name = fn?.name ?? outer?.name;
      const raw = fn?.arguments ?? outer?.parameters ?? outer?.arguments;
      const args =
        typeof raw === "string"
          ? (() => {
              try {
                return asObject(JSON.parse(raw));
              } catch {
                return null;
              }
            })()
          : asObject(raw);
      if (
        typeof name === "string" &&
        /^[a-zA-Z][a-zA-Z0-9_.-]{1,80}$/.test(name) &&
        args &&
        (outer?.type === "function" ||
          "parameters" in (outer ?? {}) ||
          "arguments" in (outer ?? {}) ||
          fn)
      )
        return {
          name,
          args,
          rest: `${content.slice(0, start)} ${content.slice(end + 1)}`
            .replace(/```(?:json)?/gi, "")
            .replace(/\s+/g, " ")
            .trim(),
        };
    } catch {
      /* not JSON: keep looking */
    }
    start = content.indexOf("{", start + 1);
  }
  return null;
}

const CALL_START = /\{\s*"(?:type|name|function)"/;
const PARTIAL_START = /\{\s*(?:"[a-z]{0,8})?$/;

/**
 * Sits between a model's token stream and the user: text is passed through at once, except a JSON object that starts like a
 * tool call, which is held back until the stream ends. If it really was a tool call it is dropped (the orchestrator runs it
 * as a real call), otherwise it is released unchanged.
 */
export class LeakedCallGuard {
  private held = "";
  private holding = false;
  private tail = "";
  constructor(private readonly emit: (text: string) => void) {}

  push(text: string): void {
    if (this.holding) {
      this.held += text;
      return;
    }
    const combined = this.tail + text;
    this.tail = "";
    const start = combined.search(CALL_START);
    if (start >= 0) {
      if (start > 0) this.emit(combined.slice(0, start));
      this.holding = true;
      this.held = combined.slice(start);
      return;
    }
    const brace = combined.lastIndexOf("{");
    if (brace >= 0 && PARTIAL_START.test(combined.slice(brace))) {
      if (brace > 0) this.emit(combined.slice(0, brace));
      this.tail = combined.slice(brace);
      return;
    }
    if (combined) this.emit(combined);
  }

  /** Call once the stream is complete. */
  finish(): void {
    const rest = this.tail + (this.holding ? this.held : "");
    this.tail = "";
    this.held = "";
    this.holding = false;
    if (rest && !findLeakedToolCall(rest)) this.emit(rest);
  }
}
