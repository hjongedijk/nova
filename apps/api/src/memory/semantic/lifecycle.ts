import type { MemoryRecord } from "@nova/contracts";

/**
 * Pure memory-lifecycle rules (no I/O): record normalisation for old data, subject/value
 * contradiction checks, retrieval ranking and the deterministic consolidation plan. The stores
 * call these; tests exercise them directly.
 */

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "assumption",
  "episode",
  "project",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_ORIGINS = ["user_stated", "inferred", "tool"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

/** Confidence an inferred memory starts with; it can never exceed this. */
export const INFERRED_CONFIDENCE = 0.4;
export const ASSUMPTION_MARKER = "(waarschijnlijk, niet bevestigd)";
export const EPISODE_TRIM_DAYS = 30;
export const SEARCH_THRESHOLD = 0.65;
export const KEYWORD_THRESHOLD = 0.55;

const DAY = 86_400_000;

/** The lifecycle fields, stored next to the existing payload (snake_case like the rest). */
export interface LifecycleFields {
  kind: MemoryKind;
  /** Who established the memory. The older `source` field keeps its original meaning. */
  origin: MemoryOrigin;
  confidence: number;
  sensitive: boolean;
  superseded_by?: string | null;
  valid_until?: string | null;
  consolidated?: boolean;
}

export type LifecycleRecord = MemoryRecord & LifecycleFields;

export function kindFromType(type: string | undefined): MemoryKind {
  switch (type) {
    case "PREFERENCE":
      return "preference";
    case "PROJECT":
      return "project";
    case "CONVERSATION_SUMMARY":
    case "ACTION_RESULT":
      return "episode";
    default:
      return "fact";
  }
}

export const isKind = (value: unknown): value is MemoryKind =>
  typeof value === "string" &&
  (MEMORY_KINDS as readonly string[]).includes(value);

export const isOrigin = (value: unknown): value is MemoryOrigin =>
  typeof value === "string" &&
  (MEMORY_ORIGINS as readonly string[]).includes(value);

/** Old records have none of the new fields: derive them on read, never rewrite on read. */
export function normalizeRecord(record: MemoryRecord): LifecycleRecord {
  const raw = record as MemoryRecord & Partial<LifecycleFields>;
  const origin: MemoryOrigin = isOrigin(raw.origin)
    ? raw.origin
    : raw.source === "scheduled_summary"
      ? "tool"
      : "user_stated";
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 1;
  return {
    ...record,
    kind: isKind(raw.kind) ? raw.kind : kindFromType(record.type),
    origin,
    confidence,
    sensitive: raw.sensitive === true,
    superseded_by:
      typeof raw.superseded_by === "string" ? raw.superseded_by : null,
    valid_until: typeof raw.valid_until === "string" ? raw.valid_until : null,
  };
}

export function isActive(record: LifecycleRecord, now = Date.now()): boolean {
  if (record.archived) return false;
  if (record.superseded_by) return false;
  if (record.valid_until && Date.parse(record.valid_until) <= now) return false;
  return true;
}

const SENSITIVE =
  /\b[A-Z]{2}\d{2}[ ]?[A-Z0-9]{4}[ ]?\d{4}[ ]?\d{2,}\b|\b(bsn|burgerservicenummer|paspoortnummer|ziekte|diagnose|medicatie)\b/i;
export const looksSensitive = (text: string): boolean => SENSITIVE.test(text);

// ---- Subject / value contradiction (deterministic) --------------------------------------------

export const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const clean = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const dropLeadingArticle = (value: string): string =>
  value.replace(/^(?:een|de|het|a|an|the)\s+/, "");

export interface SubjectClaim {
  subject: string;
  value: string;
}

/**
 * "mijn favoriete kleur is blauw" -> {subject: "favoriete kleur", value: "blauw"}. Only a few
 * unambiguous sentence shapes are recognised; anything else has no subject and is never treated
 * as a contradiction.
 */
export function subjectClaim(text: string): SubjectClaim | null {
  const lowered = clean(text);
  const subordinate = /^(?:dat|that)\s+/.test(lowered);
  const t = lowered.replace(/^(?:dat|that)\s+/, "");
  let m = /^(?:ik woon in|i live in)\s+(.{1,100})$/.exec(t);
  if (m) return { subject: "woonplaats", value: dropLeadingArticle(m[1]!) };
  m = /^(?:ik ben|i am)\s+(\d{1,3})\s*(?:jaar(?: oud)?|years? old)$/.exec(t);
  if (m) return { subject: "leeftijd", value: m[1]! };
  m =
    /^(?:mijn|m'n|onze|ons|my|our)\s+(\p{L}[\p{L}\p{N} -]{1,50}?)\s+heet\s+(.{1,100})$/u.exec(
      t,
    );
  if (m) return { subject: dropLeadingArticle(m[1]!), value: m[2]! };
  m =
    /^(?:mijn|m'n|onze|ons|my|our)\s+(\p{L}[\p{L}\p{N} -]{1,50}?)\s+(.{1,60}?)\s+heet$/u.exec(
      t,
    );
  if (m) return { subject: dropLeadingArticle(m[1]!), value: m[2]! };
  m =
    /^(?:mijn|m'n|onze|ons|de|het|my|our|the)\s+(\p{L}[\p{L}\p{N} -]{1,60}?)\s+(?:is|zijn|was|are)\s+(.{1,150})$/u.exec(
      t,
    );
  if (m)
    return {
      subject: dropLeadingArticle(m[1]!),
      value: dropLeadingArticle(m[2]!),
    };
  // "dat mijn favoriete kleur blauw is": verb last, one-word value.
  if (subordinate) {
    m =
      /^(?:mijn|m'n|onze|ons)\s+(\p{L}[\p{L}\p{N} -]{1,50}?)\s+(\p{L}[\p{L}\p{N}-]*)\s+(?:is|zijn|was)$/u.exec(
        t,
      );
    if (m) return { subject: dropLeadingArticle(m[1]!), value: m[2]! };
  }
  return null;
}

/** Same subject and a different value. Equal or merely reformatted values are not a conflict. */
export function contradicts(a: string, b: string): boolean {
  const x = subjectClaim(a);
  const y = subjectClaim(b);
  if (!x || !y) return false;
  if (normalizeText(x.subject) !== normalizeText(y.subject)) return false;
  return normalizeText(x.value) !== normalizeText(y.value);
}

// ---- Ranking -----------------------------------------------------------------------------------

const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  episode: 30,
  assumption: 90,
  decision: 365,
  project: 365,
  preference: 730,
  fact: 1460,
};

export function recencyFactor(
  record: LifecycleRecord,
  now = Date.now(),
): number {
  const stamp = Date.parse(
    record.updated_at ?? record.last_accessed_at ?? record.created_at ?? "",
  );
  if (!Number.isFinite(stamp)) return 1;
  const age = Math.max(0, (now - stamp) / DAY);
  return 0.6 + 0.4 * 0.5 ** (age / HALF_LIFE_DAYS[record.kind]);
}

export const useFactor = (record: MemoryRecord): number =>
  1 +
  Math.min(0.2, 0.05 * Math.log2(1 + Math.max(0, record.access_count ?? 0)));

/** Exact names, numbers and quoted strings in a query (what an embedding tends to blur). */
export function queryKeywords(query: string): string[] {
  const found = new Set<string>();
  for (const m of query.matchAll(/"([^"]{2,60})"|'([^']{2,60})'/g))
    found.add(normalizeText(m[1] ?? m[2] ?? ""));
  for (const m of query.matchAll(/\d[\d.,:/-]*\d|\d/g))
    found.add(normalizeText(m[0]));
  const words = query.split(/\s+/);
  words.forEach((word, index) => {
    const w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (index > 0 && w.length >= 3 && /^\p{Lu}/u.test(w))
      found.add(normalizeText(w));
  });
  found.delete("");
  return [...found];
}

export function keywordHit(record: MemoryRecord, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const words = new Set(
    record.text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const flat = normalizeText(record.text);
  return keywords.some(
    (k) => words.has(k) || (k.length >= 4 && flat.includes(k)),
  );
}

export interface Ranked {
  record: LifecycleRecord;
  score: number;
}

/**
 * similarity x recency decay x confidence x use-count (x importance, as before) with a boost for
 * exact keyword hits. Superseded, expired and archived records are dropped. Nothing below the
 * threshold is returned, so no match means an empty list, never filler.
 */
export function rankMatches(
  points: { record: MemoryRecord; similarity: number }[],
  query: string,
  now = Date.now(),
): LifecycleRecord[] {
  const keywords = queryKeywords(query);
  const ranked: Ranked[] = [];
  for (const { record, similarity } of points) {
    const normalized = normalizeRecord(record);
    if (!isActive(normalized, now)) continue;
    const hit = keywordHit(normalized, keywords);
    if (similarity < (hit ? KEYWORD_THRESHOLD : SEARCH_THRESHOLD)) continue;
    const importance =
      typeof record.importance === "number" ? record.importance : 0.6;
    const score =
      similarity *
      (0.8 + 0.2 * importance) *
      recencyFactor(normalized, now) *
      (0.5 + 0.5 * normalized.confidence) *
      useFactor(normalized) *
      (hit ? 1.25 : 1);
    ranked.push({ record: normalized, score });
  }
  return ranked
    .sort((a, b) => b.score - a.score)
    .map(({ record, score }) => ({
      ...record,
      score,
      text:
        record.kind === "assumption" || record.origin === "inferred"
          ? `${record.text} ${ASSUMPTION_MARKER}`
          : record.text,
    }));
}

// ---- Consolidation -----------------------------------------------------------------------------

export interface ConsolidationPlan {
  /** Active records whose validUntil has passed: archive them. */
  expire: string[];
  /** Exact duplicates: delete `remove`, fold its use-count into `keep`. */
  duplicates: { keep: string; remove: string[]; accessCount: number }[];
  /** Old episodes, one summary line per day. */
  episodeDays: { day: string; ids: string[]; text: string }[];
}

const clip = (value: string, n: number) =>
  value.length > n ? `${value.slice(0, n - 1)}…` : value;

export function planConsolidation(
  records: MemoryRecord[],
  now = Date.now(),
  trimDays = EPISODE_TRIM_DAYS,
): ConsolidationPlan {
  const plan: ConsolidationPlan = {
    expire: [],
    duplicates: [],
    episodeDays: [],
  };
  const live: LifecycleRecord[] = [];
  for (const raw of records) {
    const record = normalizeRecord(raw);
    if (record.archived || record.superseded_by) continue;
    if (record.valid_until && Date.parse(record.valid_until) <= now) {
      plan.expire.push(record.id);
      continue;
    }
    live.push(record);
  }
  const groups = new Map<string, LifecycleRecord[]>();
  for (const record of live) {
    const key = `${record.type ?? ""}|${record.kind}|${normalizeText(record.text)}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const removed = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Keep the most trusted, then the oldest (it carries the original createdAt).
    const sorted = [...group].sort(
      (a, b) =>
        (a.origin === "user_stated" ? 0 : 1) -
          (b.origin === "user_stated" ? 0 : 1) ||
        Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "") ||
        a.id.localeCompare(b.id),
    );
    const [keep, ...rest] = sorted as [LifecycleRecord, ...LifecycleRecord[]];
    for (const r of rest) removed.add(r.id);
    plan.duplicates.push({
      keep: keep.id,
      remove: rest.map((r) => r.id),
      accessCount: group.reduce((n, r) => n + (r.access_count ?? 0), 0),
    });
  }
  const cutoff = now - trimDays * DAY;
  const byDay = new Map<string, LifecycleRecord[]>();
  for (const record of live) {
    if (
      record.kind !== "episode" ||
      record.consolidated ||
      removed.has(record.id)
    )
      continue;
    const created = Date.parse(record.created_at ?? "");
    if (!Number.isFinite(created) || created > cutoff) continue;
    const day = new Date(created).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), record]);
  }
  for (const [day, list] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < 2) continue;
    const lines = list
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => clip(r.text.replace(/\s+/g, " ").trim(), 120));
    plan.episodeDays.push({
      day,
      ids: list.map((r) => r.id),
      text: clip(`Samenvatting ${day}: ${lines.join(" | ")}`, 600),
    });
  }
  return plan;
}

// ---- Filtering for the user-facing list ------------------------------------------------------

export interface ListFilter {
  kind?: MemoryKind;
  search?: string;
  includeHistory?: boolean;
}

export function matchesFilter(
  record: LifecycleRecord,
  filter: ListFilter,
  now = Date.now(),
): boolean {
  if (!filter.includeHistory && !isActive(record, now)) return false;
  if (filter.kind && record.kind !== filter.kind) return false;
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    if (!record.text.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Ids that were (transitively) superseded into `id`: its history chain. */
export function ancestorsOf(id: string, records: MemoryRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const target = queue.shift()!;
    for (const r of records) {
      const sup = (r as MemoryRecord & Partial<LifecycleFields>).superseded_by;
      if (sup === target && !seen.has(r.id)) {
        seen.add(r.id);
        out.push(r.id);
        queue.push(r.id);
      }
    }
  }
  return out;
}
