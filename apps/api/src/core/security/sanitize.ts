/*
 * Keeps secrets out of everything NOVA stores, logs or hands to the model: the values of
 * every *KEY/*SECRET/*TOKEN/*PASSWORD variable, bearer tokens, API keys and JWTs, and object
 * fields with sensitive names. Token-usage counters are the one exception to the name rule.
 */
const secrets = () =>
  Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /KEY|SECRET|TOKEN|PASSWORD/i.test(key) && value && value.length >= 4,
    )
    .map(([, value]) => value as string);

const USAGE_FIELD =
  /^(?:prompt|completion|input|output|total|cached|reasoning)_tokens(?:_details)?$/;
const SENSITIVE_FIELD = /authorization|password|secret|token|api.?key|headers/i;

export function sanitize<T>(value: T): T {
  if (typeof value === "string") {
    let clean: string = value;
    for (const secret of secrets())
      clean = clean.split(secret).join("[redacted]");
    return clean
      .replace(/(?:Bearer\s+|PVEAPIToken=)[^\s"'<>]+/gi, "[redacted]")
      .replace(
        /\b(sk-[a-zA-Z0-9_-]{10,}|eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_.-]+)/g,
        "[redacted]",
      )
      .replace(
        /((?:password|wachtwoord|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret)\s*(?:[:=]|is)\s*)[^\s,;]+/gi,
        "$1[redacted]",
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
