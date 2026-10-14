/*
 * Keeps secrets out of everything NOVA stores, logs or hands to the model: the values of
 * every *KEY/*SECRET/*TOKEN/*PASSWORD/*PIN variable, bearer tokens, API keys and JWTs, and object
 * fields with sensitive names. Token-usage counters are the one exception to the name rule.
 */
// Keep replaced and cleared credentials private while older text remains in memory.
// This registry is process-local and is never persisted or exposed.
const registeredSecrets = new Set<string>();

export function registerSecrets(values: Iterable<string>): void {
  for (const value of values) if (value) registeredSecrets.add(value);
}

const secrets = () =>
  [
    ...registeredSecrets,
    ...Object.entries(process.env)
      .filter(
        ([key, value]) => /KEY|SECRET|TOKEN|PASSWORD|PIN/i.test(key) && value,
      )
      .map(([, value]) => value as string),
  ].sort((left, right) => right.length - left.length);

const USAGE_FIELD =
  /^(?:prompt|completion|input|output|total|cached|reasoning)_tokens(?:_details)?$/;
const SENSITIVE_FIELD = /authorization|password|secret|token|api.?key|headers/i;

export function sanitize<T>(value: T): T {
  if (typeof value === "string") {
    let clean: string = value;
    for (const secret of secrets())
      clean = clean.split(secret).join("[redacted]");
    // Match only authority userinfo; path/query/fragment and quoted-code boundaries
    // terminate the scan. Greedy @ consumes malformed multi-@ credentials safely.
    // No URL parsing/serialization: surrounding punctuation and host bytes stay intact.
    return clean
      .replace(/(https?:\/\/)[^\s/?#"'<>`\\]+@/gi, "$1[redacted]@")
      .replace(/(?:Bearer\s+|PVEAPIToken=)[^\s"'<>]+/gi, "[redacted]")
      .replace(
        /\b(sk-[a-zA-Z0-9_-]{10,}|eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_.-]+)/g,
        "[redacted]",
      )
      .replace(
        /((?:["']?(?:password|passwd|pwd|passphrase|wachtwoord|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key|secret|credential)["']?)\s*(?:[:=]|\bis\b)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
        (match: string, prefix: string) => {
          const value = match.slice(prefix.length);
          return `${prefix}${value.startsWith('"') ? '"[redacted]"' : value.startsWith("'") ? "'[redacted]'" : "[redacted]"}`;
        },
      ) as T;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => USAGE_FIELD.test(key) || !SENSITIVE_FIELD.test(key))
        .map(([key, item]) => [key, sanitize(item)]),
    ) as T;
  return value;
}
