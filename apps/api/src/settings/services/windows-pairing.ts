import { ValidationError } from "../../core/errors/validation.error.js";
import { normalizeConnection } from "../../core/config/service-connections.js";

/** The local Windows setup emits this credential. Never echo it in errors or logs. */
export function decodeWindowsPairCode(input: unknown): {
  url: string;
  token: string;
} {
  const invalid = () => new ValidationError(["Ongeldige Windows-koppelcode."]);
  if (typeof input !== "string" || input.length > 2048) throw invalid();
  const match = /^nova1\.([A-Za-z0-9_-]+)$/.exec(input.trim());
  if (!match) throw invalid();
  try {
    const bytes = Buffer.from(match[1]!, "base64url");
    if (bytes.toString("base64url") !== match[1]) throw invalid();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalid();
    const fields = value as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(",") !== "token,url" ||
      typeof fields.url !== "string" ||
      typeof fields.token !== "string" ||
      !/^[\x21-\x7e]{24,256}$/.test(fields.token)
    )
      throw invalid();
    const address = new URL(fields.url);
    if (address.protocol !== "http:" || address.pathname !== "/")
      throw invalid();
    const normalized = normalizeConnection("windows", fields);
    return { url: String(normalized.url), token: String(normalized.token) };
  } catch {
    throw invalid();
  }
}
