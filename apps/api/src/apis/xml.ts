import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: true,
  trimValues: true,
  parseTagValue: false,
  allowBooleanAttributes: true,
});

/** Namespace prefixes removed; never throws. DOCTYPE/entities from remote XML are not expanded beyond the five basics. */
export function parseXml(text: string): Record<string, unknown> | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  try {
    return parser.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const arr = <T>(value: T | T[] | undefined | null): T[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];

export const escapeXml = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
