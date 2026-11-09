/*
 * The open Agent Skills format (https://agentskills.io/specification): a folder named after the skill
 * with a SKILL.md that starts with YAML frontmatter (`name`, `description`, optional `license`,
 * `compatibility`, `metadata`, `allowed-tools`) followed by Markdown instructions, plus optional
 * reference files. NOVA reads skills as text only: bundled scripts are never stored or run.
 *
 * The frontmatter parser is deliberately small and strict instead of a full YAML implementation:
 * it understands plain, quoted and block (`>`/`|`) scalars, a one-level `metadata` map and skips
 * unknown keys (with their nested lines). Anything else is rejected.
 */

export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_REFERENCE_BYTES = 64 * 1024;
export const MAX_REFERENCE_FILES = 24;
export const MAX_SKILL_TOTAL_BYTES = 512 * 1024;
const MAX_FRONTMATTER_BYTES = 8 * 1024;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
  body: string;
  /** Frontmatter keys outside the specification; they are ignored. */
  ignoredKeys: string[];
}

export class SkillFormatError extends Error {}

export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && NAME.test(value);
}

type Raw = { kind: "scalar"; value: string } | { kind: "map"; lines: string[] };

function unquote(value: string): string {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2)
      throw new SkillFormatError(
        "Onafgesloten aanhalingsteken in frontmatter.",
      );
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2)
      throw new SkillFormatError(
        "Onafgesloten aanhalingsteken in frontmatter.",
      );
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

const indent = (line: string) => line.length - line.trimStart().length;

function blockScalar(header: string, lines: string[]): string {
  const literal = header.startsWith("|");
  const keep = header.includes("+");
  const strip = header.includes("-");
  const nonEmpty = lines.filter((line) => line.trim());
  const base = nonEmpty.length ? Math.min(...nonEmpty.map(indent)) : 0;
  const content = lines.map((line) => line.slice(base).trimEnd());
  let text: string;
  if (literal) text = content.join("\n");
  else {
    text = "";
    for (const line of content) {
      if (!line) text += "\n";
      else text += text && !text.endsWith("\n") ? ` ${line}` : line;
    }
  }
  if (strip) return text.replace(/\n+$/, "");
  return keep ? `${text}\n` : `${text.replace(/\n+$/, "")}\n`;
}

function parseFrontmatter(source: string): Map<string, Raw> {
  const lines = source.split("\n");
  const fields = new Map<string, Raw>();
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (indent(line) !== 0 || line.startsWith("\t"))
      throw new SkillFormatError(
        `Onverwachte inspringing in frontmatter (regel ${index + 2}).`,
      );
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!KEY.test(key))
      throw new SkillFormatError(
        `Ongeldige frontmatterregel (regel ${index + 2}).`,
      );
    if (fields.has(key))
      throw new SkillFormatError(`Dubbel veld “${key}” in frontmatter.`);
    const rest = line.slice(colon + 1).trim();
    index += 1;
    const nested: string[] = [];
    while (
      index < lines.length &&
      (!lines[index]!.trim() || indent(lines[index]!) > 0)
    ) {
      nested.push(lines[index]!);
      index += 1;
    }
    while (nested.length && !nested.at(-1)!.trim()) nested.pop();
    if (/^[>|][+-]?$/.test(rest))
      fields.set(key, { kind: "scalar", value: blockScalar(rest, nested) });
    else if (!rest) fields.set(key, { kind: "map", lines: nested });
    else if (nested.length && !/^["']/.test(rest))
      fields.set(key, {
        kind: "scalar",
        value: [rest, ...nested.map((item) => item.trim())]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+#.*$/, ""),
      });
    else if (nested.length) {
      // A quoted scalar that continues on the next lines: fold it into one line.
      fields.set(key, {
        kind: "scalar",
        value: unquote(
          [rest, ...nested.map((item) => item.trim())].join(" ").trim(),
        ),
      });
    } else fields.set(key, { kind: "scalar", value: unquote(rest) });
  }
  return fields;
}

function scalar(
  fields: Map<string, Raw>,
  key: string,
  max: number,
  required = false,
): string | null {
  const raw = fields.get(key);
  if (!raw) {
    if (required)
      throw new SkillFormatError(`Het verplichte veld “${key}” ontbreekt.`);
    return null;
  }
  if (raw.kind !== "scalar")
    throw new SkillFormatError(`Het veld “${key}” moet tekst zijn.`);
  const value = raw.value.trim();
  if (!value) {
    if (required)
      throw new SkillFormatError(`Het veld “${key}” mag niet leeg zijn.`);
    return null;
  }
  if (value.length > max)
    throw new SkillFormatError(
      `Het veld “${key}” is langer dan ${max} tekens.`,
    );
  if (CONTROL.test(value))
    throw new SkillFormatError(`Het veld “${key}” bevat stuurtekens.`);
  return value;
}

function metadataMap(fields: Map<string, Raw>): Record<string, string> {
  const raw = fields.get("metadata");
  if (!raw) return {};
  if (raw.kind !== "map")
    throw new SkillFormatError(
      "Het veld “metadata” moet een lijst sleutels zijn.",
    );
  const result: Record<string, string> = {};
  for (const line of raw.lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^\s+([A-Za-z0-9_.-]{1,64}):\s*(.*)$/.exec(line);
    if (!match)
      throw new SkillFormatError(
        "“metadata” mag alleen sleutel: waarde bevatten.",
      );
    const value = unquote(match[2]!.trim());
    if (value.length > 200 || CONTROL.test(value))
      throw new SkillFormatError("Een “metadata”-waarde is ongeldig.");
    if (Object.keys(result).length >= 32)
      throw new SkillFormatError("“metadata” heeft te veel sleutels.");
    result[match[1]!] = value;
  }
  return result;
}

/** Parse and validate one SKILL.md. `folder` is the directory name it must match, when known. */
export function parseSkillMarkdown(
  input: string,
  folder?: string,
): ParsedSkill {
  if (Buffer.byteLength(input) > MAX_SKILL_BYTES)
    throw new SkillFormatError("SKILL.md is groter dan 64 KiB.");
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n"))
    throw new SkillFormatError(
      "SKILL.md moet met YAML-frontmatter (---) beginnen.",
    );
  const end = text.indexOf("\n---", 3);
  if (end < 0 || !/^\n---[ \t]*(?:\n|$)/.test(text.slice(end)))
    throw new SkillFormatError(
      "De frontmatter van SKILL.md is niet afgesloten.",
    );
  const front = text.slice(4, end + 1);
  if (Buffer.byteLength(front) > MAX_FRONTMATTER_BYTES)
    throw new SkillFormatError("De frontmatter is te groot.");
  const body = text
    .slice(end + 4)
    .replace(/^[ \t]*\n/, "")
    .trim();
  const fields = parseFrontmatter(front);
  const name = scalar(fields, "name", 64, true)!;
  if (!NAME.test(name))
    throw new SkillFormatError(
      "De naam mag alleen kleine letters, cijfers en losse koppeltekens bevatten.",
    );
  if (folder !== undefined && folder !== name)
    throw new SkillFormatError(
      `De naam “${name}” komt niet overeen met de map “${folder}”.`,
    );
  const description = scalar(fields, "description", 1024, true)!.replace(
    /\s+/g,
    " ",
  );
  const known = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);
  return {
    name,
    description,
    license: scalar(fields, "license", 200),
    compatibility: scalar(fields, "compatibility", 500),
    metadata: metadataMap(fields),
    allowedTools: scalar(fields, "allowed-tools", 1024),
    body,
    ignoredKeys: [...fields.keys()].filter((key) => !known.has(key)),
  };
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LICENSE = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:\.(?:md|txt))?$/i;

/**
 * A bundled file NOVA keeps and lets the model read: Markdown or plain text, at most three folders
 * deep, no hidden or parent segments. Returns the normalized relative path or null.
 */
export function referencePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 200) return null;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/"))
    return null;
  const parts = value.split("/");
  if (parts.length > 4 || parts.some((part) => !SEGMENT.test(part)))
    return null;
  if (parts.some((part) => /\.\./.test(part))) return null;
  const file = parts.at(-1)!;
  if (!/\.(?:md|markdown|txt)$/i.test(file) && !LICENSE.test(file)) return null;
  return parts.join("/");
}
