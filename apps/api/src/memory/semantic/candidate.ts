import { sanitize } from "../../core/security/sanitize.js";

export const MEMORY_TYPES = [
  "USER_FACT",
  "PREFERENCE",
  "DEVICE_CONTEXT",
  "HOME_CONTEXT",
  "INFRASTRUCTURE",
  "CONVERSATION_SUMMARY",
  "PROCEDURE",
  "ACTION_RESULT",
  "LEARNED_ALIAS",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryCandidate {
  text: string;
  type: MemoryType;
  source: "explicit_user" | "conversation_fact";
  importance: number;
  confidence: number;
  tags: string[];
  related_entity: string | null;
  related_area: string | null;
  related_device: string | null;
}

export interface CandidateMetadata {
  explicit?: boolean;
  type?: string;
  importance?: unknown;
  tags?: unknown;
  related_entity?: string | null;
  related_area?: string | null;
  related_device?: string | null;
}

/**
 * Whether something may become a long-term memory, and as what. Secrets, current states and
 * one-off requests never qualify; automatic writes need an explicit "onthoud" or a durable fact.
 */
export function memoryCandidate(
  text: unknown,
  metadata: CandidateMetadata = {},
): MemoryCandidate | null {
  if (typeof text !== "string" || text.length < 5 || text.length > 2000)
    return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    /bearer\s|PVEAPIToken|(?:api[ _-]?key|password|wachtwoord|token|secret|authorization|private.key|credential|pincode)\b|sk-[a-z0-9_-]{10,}|eyJ[a-z0-9_-]{15,}|-----BEGIN|https?:\/\/[^\s/]+:[^\s]+@/i.test(
      normalized,
    )
  )
    return null;
  if (
    JSON.stringify(sanitize({ text: normalized })) !==
    JSON.stringify({ text: normalized })
  )
    return null;
  if (
    /\b(nu|vandaag|currently|right now|today|tijdelijk|temporary)\b/i.test(
      normalized,
    )
  )
    return null;
  const explicit =
    /^(onthoud|remember|bewaar als voorkeur|mijn voorkeur is|my preference is)\b\s*[:,-]?\s*/i;
  const durableFact =
    /^(mijn naam is|my name is|ik woon in|i live in|ik geef de voorkeur aan|i prefer|mijn kantoor is|my office is)\b/i.test(
      normalized,
    );
  if (!explicit.test(normalized) && !metadata.explicit && !durableFact)
    return null;
  if (
    /\b(is|staat|zijn|are)\s+(aan|uit|on|off|open|closed|running|stopped|playing|paused|idle|online|offline)\b/i.test(
      normalized,
    )
  )
    return null;
  const content = normalized.replace(explicit, "").trim();
  if (
    content.length < 5 ||
    /^(hallo|hi|hello|hey|dank|thanks)\b/i.test(content)
  )
    return null;
  const type = (metadata.type ??
    (/\b(noem|alias|call .+|heet)\b/i.test(content)
      ? "LEARNED_ALIAS"
      : /\b(voorkeur|prefer|graag|volume|temperatuur)\b/i.test(content)
        ? "PREFERENCE"
        : "USER_FACT")) as MemoryType;
  if (!MEMORY_TYPES.includes(type)) return null;
  return {
    text: content,
    type,
    source:
      explicit.test(normalized) || metadata.explicit
        ? "explicit_user"
        : "conversation_fact",
    importance: Math.max(0, Math.min(1, Number(metadata.importance) || 0.6)),
    confidence: 1,
    tags: Array.isArray(metadata.tags)
      ? metadata.tags
          .filter((tag): tag is string => typeof tag === "string")
          .slice(0, 10)
      : [],
    related_entity: metadata.related_entity || null,
    related_area: metadata.related_area || null,
    related_device: metadata.related_device || null,
  };
}
