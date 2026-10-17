/*
 * A token pasted into the chat next to a URL is a credential, not conversation. It is moved to the encrypted vault
 * before the message reaches the model, the memory or the log; the text keeps only a reference.
 * The detection is a pure function (findSecrets); the vault call is injected so this file has no dependencies.
 */
export interface FoundMessageSecret {
  start: number;
  end: number;
  value: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const KEYWORD =
  "(?:api[ _-]?(?:key|token|sleutel)|apikey|access[ _-]?token|auth[ _-]?token|token|bearer|authorization|autorisatie|sleutel|wachtwoord|password|secret|geheim)";
// keyword, up to three filler words ("is", "=", "van mij is", ...), then the value.
const AFTER_KEYWORD = new RegExp(
  `\\b${KEYWORD}\\b(?:\\s*[:=]\\s*|(?:\\s+\\S{1,60}){0,4}\\s+)["'\`]?((?:Bearer\\s+)?[A-Za-z0-9._~+/=\\-]{8,})`,
  "gi",
);
const KNOWN_PREFIX =
  /\b(?:sk-[A-Za-z0-9_-]{6,}|(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+)/g;

/** A value that looks like a credential: long enough, no URL, mixed letters and digits (or a known prefix). */
export function looksLikeSecret(value: string): boolean {
  if (/^https?:/i.test(value) || value.length < 8) return false;
  if (/^(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox|AKIA|eyJ)/.test(value))
    return true;
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  if (hasDigit && hasLetter) return true;
  return (
    value.length >= 24 &&
    /[A-Za-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value)
  );
}

export function findSecrets(message: string): FoundMessageSecret[] {
  if (!/https?:\/\//i.test(message)) return [];
  const urlRanges = [...message.matchAll(URL_PATTERN)].map(
    (m) => [m.index!, m.index! + m[0].length] as const,
  );
  const insideUrl = (start: number) =>
    urlRanges.some(([a, b]) => start >= a && start < b);
  const found = new Map<number, FoundMessageSecret>();
  const add = (start: number, value: string) => {
    const clean = value.replace(/^Bearer\s+/i, "");
    const offset = start + value.length - clean.length;
    if (insideUrl(offset) || !looksLikeSecret(clean)) return;
    found.set(offset, {
      start: offset,
      end: offset + clean.length,
      value: clean,
    });
  };
  const hasKeyword = new RegExp(`\\b${KEYWORD}\\b`, "i").test(message);
  if (!hasKeyword) return [];
  for (const m of message.matchAll(AFTER_KEYWORD))
    add(m.index! + m[0].length - m[1]!.length, m[1]!);
  for (const m of message.matchAll(KNOWN_PREFIX)) add(m.index!, m[0]);
  return [...found.values()].sort((a, b) => a.start - b.start);
}

export interface InterceptResult {
  message: string;
  refs: string[];
}

/** Replace every credential in `message` with a reference obtained from `store`. */
export function interceptSecrets(
  message: string,
  store: (value: string, host: string | undefined) => string,
): InterceptResult {
  const secrets = findSecrets(message);
  if (!secrets.length) return { message, refs: [] };
  const hosts = new Set(
    [...message.matchAll(URL_PATTERN)]
      .map((m) => {
        try {
          return new URL(m[0]).host;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  const host = hosts.size === 1 ? [...hosts][0] : undefined;
  let out = "";
  let cursor = 0;
  const refs: string[] = [];
  for (const secret of secrets) {
    if (secret.start < cursor) continue;
    const ref = store(secret.value, host);
    refs.push(ref);
    out += `${message.slice(cursor, secret.start)}[geheim opgeslagen als ${ref}]`;
    cursor = secret.end;
  }
  out += message.slice(cursor);
  return {
    message: `${out}\n\n[NOVA: ${refs.length === 1 ? "het geheim is" : "de geheimen zijn"} veilig opgeslagen (${refs.join(", ")}). Gebruik bij api_connect credential_ref, nooit de waarde zelf.]`,
    refs,
  };
}

interface VaultLike {
  put(value: string, label?: string, host?: string): string;
}

/** The controller hook: returns the body with its message cleaned; anything that is not a plain chat message passes through. */
export function interceptChatBody<T extends { message?: unknown }>(
  body: T,
  vault: VaultLike | undefined,
): T {
  if (!vault || !body || typeof body.message !== "string") return body;
  try {
    const result = interceptSecrets(body.message, (value, host) =>
      vault.put(value, "chat", host),
    );
    return result.refs.length ? { ...body, message: result.message } : body;
  } catch {
    // Never let a vault problem send the raw credential to the model: drop the message text instead.
    return {
      ...body,
      message:
        "[bericht bevatte een geheim en is niet verwerkt: de kluis is niet beschikbaar]",
    };
  }
}
