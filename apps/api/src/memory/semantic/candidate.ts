import { sanitize } from "../../core/security/sanitize.js";
import {
  INFERRED_CONFIDENCE,
  isKind,
  kindFromType,
  looksSensitive,
  type MemoryKind,
  type MemoryOrigin,
} from "./lifecycle.js";

export const MEMORY_TYPES = [
  "USER_FACT",
  "PERSON",
  "PET",
  "PREFERENCE",
  "HABIT",
  "PROJECT",
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
  source: "explicit_user" | "conversation_fact" | "scheduled_summary";
  importance: number;
  confidence: number;
  tags: string[];
  related_entity: string | null;
  related_area: string | null;
  related_device: string | null;
  kind: MemoryKind;
  origin: MemoryOrigin;
  sensitive: boolean;
  valid_until: string | null;
}

export interface CandidateMetadata {
  /** 'inferred' memories are assumptions: lower confidence, never override the user's words. */
  origin?: unknown;
  kind?: unknown;
  confidence?: unknown;
  valid_until?: unknown;
  explicit?: boolean;
  scheduledSummary?: boolean;
  type?: string;
  importance?: unknown;
  tags?: unknown;
  related_entity?: string | null;
  related_area?: string | null;
  related_device?: string | null;
}

const SECRET =
  /bearer\s|PVEAPIToken|(?:api[ _-]?key|password|wachtwoord|token|secret|authorization|private.key|credential|pincode)\b|sk-[a-z0-9_-]{10,}|eyJ[a-z0-9_-]{15,}|-----BEGIN|https?:\/\/[^\s/]+:[^\s]+@|\b(?:\d[ -]?){13,19}\b/i;

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
  if (SECRET.test(normalized)) return null;
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
  const inferred = metadata.origin === "inferred";
  if (inferred && looksSensitive(normalized)) return null;
  if (
    !inferred &&
    !explicit.test(normalized) &&
    !metadata.explicit &&
    !metadata.scheduledSummary &&
    !durableFact
  )
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
  const type = (metadata.type ?? inferMemoryType(content)) as MemoryType;
  if (!MEMORY_TYPES.includes(type)) return null;
  const validUntil = safeValidUntil(metadata.valid_until);
  if (validUntil === undefined) return null;
  const kind: MemoryKind = inferred
    ? "assumption"
    : isKind(metadata.kind)
      ? metadata.kind
      : kindFromType(type);
  const givenConfidence = Number(metadata.confidence);
  const confidence = inferred
    ? Math.min(
        INFERRED_CONFIDENCE,
        Number.isFinite(givenConfidence) && metadata.confidence !== undefined
          ? Math.max(0, givenConfidence)
          : INFERRED_CONFIDENCE,
      )
    : 1;
  const relatedEntity = safeMetadataText(metadata.related_entity);
  const relatedArea = safeMetadataText(metadata.related_area);
  const relatedDevice = safeMetadataText(metadata.related_device);
  if (
    relatedEntity === undefined ||
    relatedArea === undefined ||
    relatedDevice === undefined
  )
    return null;
  return {
    text: content,
    type,
    source: metadata.scheduledSummary
      ? "scheduled_summary"
      : !inferred && (explicit.test(normalized) || metadata.explicit)
        ? "explicit_user"
        : "conversation_fact",
    kind,
    origin: inferred
      ? "inferred"
      : metadata.scheduledSummary
        ? "tool"
        : "user_stated",
    sensitive: looksSensitive(normalized),
    valid_until: validUntil,
    importance: Math.max(0, Math.min(1, Number(metadata.importance) || 0.6)),
    confidence,
    tags: safeTags(metadata.tags),
    related_entity: relatedEntity,
    related_area: relatedArea,
    related_device: relatedDevice,
  };
}

function inferMemoryType(content: string): MemoryType {
  if (/\b(project|projectnaam|projectwerk)\b/i.test(content)) return "PROJECT";
  if (/\b(hond|kat|konijn|cavia|vogel|paard|huisdier)\b/i.test(content))
    return "PET";
  if (
    /\b(partner|vrouw|man|dochter|zoon|moeder|vader|broer|zus|vriend|vriendin|collega|buurman|buurvrouw)\b/i.test(
      content,
    )
  )
    return "PERSON";
  if (
    /\b(elke|iedere|elke dag|elke week|routine|gewoonte|habit)\b/i.test(content)
  )
    return "HABIT";
  if (/\b(voorkeur|prefer|graag|volume|temperatuur)\b/i.test(content))
    return "PREFERENCE";
  if (/\b(noem|alias|call .+|heet)\b/i.test(content)) return "LEARNED_ALIAS";
  return "USER_FACT";
}

/** Null: no expiry. Undefined: malformed. */
function safeValidUntil(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Undefined means the field was absent; null is a valid empty relationship. */
function safeMetadataText(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 200) return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    SECRET.test(normalized) ||
    sanitize({ value: normalized }).value !== normalized
  )
    return undefined;
  return normalized;
}

function safeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(
      (tag) =>
        tag.length > 0 &&
        tag.length <= 60 &&
        !SECRET.test(tag) &&
        sanitize({ tag }).tag === tag,
    )
    .slice(0, 10);
}
