import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
} from "@nova/contracts";
import {
  messageOf,
  validMemoryId,
  type MemoryWriteOutcome,
  type SemanticBackend,
} from "./backend.js";
import {
  memoryCandidate,
  type CandidateMetadata,
  type MemoryCandidate,
} from "./candidate.js";
import {
  ancestorsOf,
  contradicts,
  isActive,
  normalizeRecord,
  normalizeText,
  planConsolidation,
  rankMatches,
  type LifecycleRecord,
} from "./lifecycle.js";
import { sanitize } from "../../core/security/sanitize.js";

type Fetcher = typeof fetch;

export interface EmbeddingOptions {
  fetcher?: Fetcher;
  /** OmniRoute's OpenAI-compatible base URL (ends in /v1). */
  url: string;
  key: string;
  model: string;
  dimensions: number;
  freeVerified: boolean;
  assertFreeModel(model: string): void;
}

/**
 * Embeddings through OmniRoute only: credentials stay there and the model must be restricted to a
 * free provider there. Never a local model, never made-up vectors.
 */
export class RemoteEmbeddings {
  private readonly fetcher: Fetcher;
  private readonly cache = new Map<string, number[]>();
  model: string;
  dimensions: number;
  freeVerified: boolean;

  constructor(private readonly options: EmbeddingOptions) {
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.freeVerified = options.freeVerified;
  }

  get configured(): boolean {
    return Boolean(this.model && this.dimensions > 0 && this.freeVerified);
  }

  async embed(text: string): Promise<number[]> {
    if (!this.configured)
      throw new Error("No verified free remote embedding provider configured");
    this.options.assertFreeModel(this.model);
    const safeText = sanitize(text);
    const key = crypto.createHash("sha256").update(safeText).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const response = await this.fetcher(
      `${this.options.url.replace(/\/$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: safeText }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error("Remote embedding unavailable");
    const data = (await response.json()) as {
      data?: { embedding?: unknown }[];
    };
    const vector = data?.data?.[0]?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== this.dimensions ||
      vector.some((value) => !Number.isFinite(value))
    )
      throw new Error("Invalid embedding dimensions");
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, vector as number[]);
    return vector as number[];
  }
}

interface Point {
  id: string;
  score: number;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Qdrant payloads are free-form
}

class QdrantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface QdrantOptions {
  url: string;
  collection: string;
  apiKey?: string;
  fetcher?: Fetcher;
  /** Local pointer switches only after a fully verified replacement collection is durable. */
  activeCollectionPath?: string;
  embeddings: RemoteEmbeddings;
}

export interface QdrantIndexRevision {
  id: string;
  at: string;
  before: string;
  after: string;
  points: number;
  embeddingModel: string;
  dimensions: number;
}

/** Long-term memory in a Qdrant collection, found by cosine similarity on remote embeddings. */
export class QdrantMemory implements SemanticBackend {
  private readonly url: string;
  private readonly fetcher: Fetcher;
  readonly sourceCollection: string;
  private activeCollectionName: string;
  private indexRevisions: QdrantIndexRevision[] = [];
  private readonly activeCollectionPath?: string;
  readonly embeddings: RemoteEmbeddings;
  private initialized = false;
  private reindexing = false;
  private activeMutations = 0;
  lastError: string | null = null;

  constructor(private readonly options: QdrantOptions) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.collection))
      throw new Error("Invalid memory collection");
    this.url = options.url.replace(/\/$/, "");
    this.sourceCollection = options.collection;
    this.activeCollectionPath = options.activeCollectionPath;
    const pointer = this.readActiveCollection(options);
    this.activeCollectionName = pointer.active;
    this.indexRevisions = pointer.revisions;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.embeddings = options.embeddings;
  }

  get configured(): boolean {
    return this.embeddings.configured;
  }

  private get base(): string {
    return `/collections/${this.activeCollectionName}`;
  }

  get collection(): string {
    return this.activeCollectionName;
  }

  private reindexedPrefix(): string {
    return `nova_mem_${crypto.createHash("sha256").update(this.sourceCollection).digest("hex").slice(0, 8)}_`;
  }

  private validCollectionName(name: unknown): name is string {
    if (name === this.sourceCollection) return true;
    return (
      typeof name === "string" &&
      new RegExp(`^${this.reindexedPrefix()}[0-9a-f]{32}$`).test(name)
    );
  }

  private readActiveCollection(options: QdrantOptions): {
    active: string;
    revisions: QdrantIndexRevision[];
  } {
    if (
      !options.activeCollectionPath ||
      !fs.existsSync(options.activeCollectionPath)
    )
      return { active: options.collection, revisions: [] };
    const value: unknown = JSON.parse(
      fs.readFileSync(options.activeCollectionPath, "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Qdrant active collection pointer");
    const row = value as Record<string, unknown>;
    if (
      (row.version !== 1 && row.version !== 2) ||
      row.sourceCollection !== options.collection ||
      !this.validCollectionName(row.activeCollection)
    )
      throw new Error("Invalid Qdrant active collection pointer");
    const revisions = row.version === 2 ? row.revisions : [];
    if (!Array.isArray(revisions) || revisions.length > 20)
      throw new Error("Invalid Qdrant index history");
    const validRevisions = revisions.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("Invalid Qdrant index history");
      const revision = entry as Record<string, unknown>;
      if (
        typeof revision.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(revision.id) ||
        typeof revision.at !== "string" ||
        !Number.isFinite(Date.parse(revision.at)) ||
        !this.validCollectionName(revision.before) ||
        !this.validCollectionName(revision.after) ||
        !Number.isSafeInteger(revision.points) ||
        (revision.points as number) < 0 ||
        typeof revision.embeddingModel !== "string" ||
        !Number.isSafeInteger(revision.dimensions) ||
        (revision.dimensions as number) < 1
      )
        throw new Error("Invalid Qdrant index history");
      return revision as unknown as QdrantIndexRevision;
    });
    return { active: row.activeCollection, revisions: validRevisions };
  }

  private persistActiveCollection(
    name: string,
    revisions: QdrantIndexRevision[],
  ): void {
    if (!this.activeCollectionPath) return;
    fs.mkdirSync(path.dirname(this.activeCollectionPath), { recursive: true });
    const temporary = `${this.activeCollectionPath}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(temporary, "w", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            version: 2,
            sourceCollection: this.sourceCollection,
            activeCollection: name,
            revisions: revisions.slice(-20),
          }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.activeCollectionPath);
      this.activeCollectionName = name;
      this.indexRevisions = revisions.slice(-20);
      const directory = fs.openSync(
        path.dirname(this.activeCollectionPath),
        "r",
      );
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private beginMutation(): boolean {
    if (this.reindexing) return false;
    this.activeMutations++;
    return true;
  }

  private endMutation(): void {
    this.activeMutations = Math.max(0, this.activeMutations - 1);
  }

  indexHistory(): QdrantIndexRevision[] {
    return this.indexRevisions.map((revision) => ({ ...revision })).reverse();
  }

  private async request<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any -- Qdrant replies are untyped JSON
    endpoint: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetcher(`${this.url}${endpoint}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { "api-key": this.options.apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new QdrantError(
        `Qdrant unavailable (${response.status})`,
        response.status,
      );
    return (await response.json()) as T;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.embeddings.configured)
      throw new Error("No verified free remote embedding provider configured");
    try {
      const info = await this.request(this.base);
      const vectors = info.result?.config?.params?.vectors;
      if (
        vectors?.size !== this.embeddings.dimensions ||
        vectors?.distance !== "Cosine"
      )
        throw new Error(
          "Existing Qdrant dimensions differ; collection preserved",
        );
    } catch (error) {
      if (!(error instanceof QdrantError) || error.status !== 404) throw error;
      if (this.activeCollectionName !== this.sourceCollection)
        throw new Error("The active Qdrant memory index is missing", {
          cause: error,
        });
      await this.request(this.base, "PUT", {
        vectors: { size: this.embeddings.dimensions, distance: "Cosine" },
      });
      for (const field of [
        "type",
        "archived",
        "related_entity",
        "embedding_model",
      ])
        await this.request(`${this.base}/index?wait=true`, "PUT", {
          field_name: field,
          field_schema: field === "archived" ? "bool" : "keyword",
        });
    }
    this.initialized = true;
  }

  private async nearest(vector: number[], limit = 8): Promise<Point[]> {
    const data = await this.request(`${this.base}/points/query`, "POST", {
      query: vector,
      limit,
      with_payload: true,
      filter: {
        must: [
          { key: "embedding_model", match: { value: this.embeddings.model } },
        ],
        must_not: [{ key: "archived", match: { value: true } }],
      },
    });
    return data.result?.points ?? [];
  }

  async search(
    text: string,
    { limit = 6, markAccess = true } = {},
  ): Promise<MemoryRecord[]> {
    if (!this.embeddings.configured) return [];
    try {
      await this.init();
      const wanted = Math.min(20, Math.max(1, limit));
      // Over-fetch: superseded and expired records occupy neighbour slots but are not returned.
      const points = await this.nearest(
        await this.embeddings.embed(text),
        Math.min(60, wanted * 3),
      );
      const matches = rankMatches(
        points.map((point) => ({
          record: { id: point.id, ...point.payload } as MemoryRecord,
          similarity: point.score,
        })),
        text,
      ).slice(0, wanted);
      if (markAccess && this.beginMutation()) {
        try {
          await Promise.all(
            matches.map((item) =>
              this.request(`${this.base}/points/payload?wait=true`, "POST", {
                points: [item.id],
                payload: {
                  access_count: (item.access_count ?? 0) + 1,
                  last_accessed_at: new Date().toISOString(),
                },
              }),
            ),
          );
        } finally {
          this.endMutation();
        }
      }
      this.lastError = null;
      return matches;
    } catch (error) {
      this.lastError = messageOf(error);
      return [];
    }
  }

  private async setPayload(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`${this.base}/points/payload?wait=true`, "POST", {
      points: [id],
      payload,
    });
  }

  private async retrieve(id: string): Promise<LifecycleRecord | null> {
    const data = await this.request(`${this.base}/points`, "POST", {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });
    const point = (data.result as Point[] | undefined)?.[0];
    return point
      ? normalizeRecord({ id: point.id, ...point.payload } as MemoryRecord)
      : null;
  }

  /** Every stored record (bounded), for consolidation and chain deletion. */
  private async everything(cap = 10_000): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    let offset: unknown;
    do {
      const page = await this.list(100, offset);
      out.push(...page.memories);
      offset = page.next;
    } while (offset && out.length < cap);
    return out;
  }

  /** Mark `old` as replaced by `newId`: kept as history, no longer retrievable. */
  private async supersede(old: LifecycleRecord, newId: string, now: string) {
    await this.setPayload(old.id, {
      superseded_by: newId,
      valid_until: now,
      updated_at: now,
    });
  }

  private buildPayload(
    id: string,
    candidate: MemoryCandidate,
    now: string,
    previous?: LifecycleRecord,
  ): Record<string, unknown> {
    return {
      id,
      embedding_model: this.embeddings.model,
      ...candidate,
      created_at: previous?.created_at ?? now,
      updated_at: now,
      last_accessed_at: previous?.last_accessed_at ?? null,
      access_count: previous?.access_count ?? 0,
      archived: false,
      superseded_by: null,
    };
  }

  async write(
    text: unknown,
    metadata: CandidateMetadata = {},
  ): Promise<MemoryWriteOutcome> {
    const candidate = memoryCandidate(text, metadata);
    if (!candidate)
      return {
        ok: false,
        error: "Memory rejected: not durable or contains secrets",
      };
    if (!this.beginMutation())
      return { ok: false, error: "Memory index is rebuilding; retry shortly" };
    try {
      await this.init();
      const vector = await this.embeddings.embed(candidate.text);
      const neighbours = (await this.nearest(vector, 12))
        .map((point) => ({
          point,
          record: normalizeRecord({
            id: point.id,
            ...point.payload,
          } as MemoryRecord),
        }))
        .filter(({ record }) => isActive(record));
      const now = new Date().toISOString();
      const inferred = candidate.origin === "inferred";

      // 1. Near-duplicate: update instead of storing a second copy.
      const same = neighbours.find(
        ({ point, record }) =>
          record.type === candidate.type &&
          (normalizeText(record.text) === normalizeText(candidate.text) ||
            (point.score >= 0.97 &&
              record.related_entity === candidate.related_entity &&
              !contradicts(record.text, candidate.text))),
      );
      if (same) {
        const previous = same.record;
        if (inferred && previous.origin === "user_stated")
          return {
            ok: true,
            id: previous.id,
            operation: "merged",
            unchanged: true,
            memory: previous,
            message: "Dit wist je al van de gebruiker; niets gewijzigd.",
          };
        const keepsUserWords = previous.origin === "user_stated" || !inferred;
        const merged = {
          ...this.buildPayload(previous.id, candidate, now, previous),
          origin: keepsUserWords ? "user_stated" : "inferred",
          kind:
            keepsUserWords && candidate.kind === "assumption"
              ? previous.kind
              : candidate.kind,
          confidence: Math.max(previous.confidence, candidate.confidence),
          superseded_by: previous.superseded_by ?? null,
        };
        await this.request(`${this.base}/points?wait=true`, "PUT", {
          points: [{ id: previous.id, vector, payload: merged }],
        });
        this.lastError = null;
        return {
          ok: true,
          id: previous.id,
          operation: "merged",
          memory: merged as unknown as MemoryRecord,
        };
      }

      // 2. Contradiction with the same subject: the embedding only found the candidates.
      const conflicts = neighbours.filter(({ record }) =>
        contradicts(record.text, candidate.text),
      );
      const id = crypto.randomUUID();
      let payload = this.buildPayload(id, candidate, now);
      let message: string | undefined;
      const replaced: { id: string; text: string }[] = [];
      const blocking = conflicts.find(
        ({ record }) => inferred && record.origin === "user_stated",
      );
      if (blocking) {
        // An assumption never overrides what the user said; it stays an unconfirmed assumption.
        payload = { ...payload, kind: "assumption", origin: "inferred" };
        message = `Je zei eerder: "${blocking.record.text}". Dit nieuwe is een aanname (niet bevestigd) en overschrijft dat niet.`;
      } else {
        for (const { record } of conflicts) {
          await this.supersede(record, id, now);
          replaced.push({ id: record.id, text: record.text });
        }
        if (replaced.length)
          message = `Eerder zei je "${replaced.map((r) => r.text).join('"; "')}", nu "${candidate.text}": bijgewerkt.`;
      }
      await this.request(`${this.base}/points?wait=true`, "PUT", {
        points: [{ id, vector, payload }],
      });
      this.lastError = null;
      return {
        ok: true,
        id,
        operation: "created",
        memory: payload as unknown as MemoryRecord,
        ...(replaced.length ? { superseded: replaced } : {}),
        ...(blocking ? { conflictWith: blocking.record.id } : {}),
        ...(message ? { message } : {}),
      };
    } catch (error) {
      this.lastError = messageOf(error);
      return { ok: false, error: this.lastError };
    } finally {
      this.endMutation();
    }
  }

  /** Replace a record's text with supersede semantics: the old text stays as history. */
  async correct(id: string, text: unknown): Promise<MemoryWriteOutcome> {
    if (!validMemoryId(id)) throw new Error("Invalid memory ID");
    if (!this.beginMutation())
      return { ok: false, error: "Memory index is rebuilding; retry shortly" };
    try {
      await this.init();
      const old = await this.retrieve(id);
      if (!old || !isActive(old))
        return { ok: false, error: "Memory not found" };
      const candidate = memoryCandidate(text, {
        explicit: true,
        type: old.type,
        related_entity: old.related_entity,
        related_area: old.related_area,
        related_device: old.related_device,
        tags: old.tags,
        importance: old.importance,
        kind: old.kind === "assumption" ? "fact" : old.kind,
      });
      if (!candidate)
        return {
          ok: false,
          error: "Memory rejected: not durable or contains secrets",
        };
      const vector = await this.embeddings.embed(candidate.text);
      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const payload = this.buildPayload(newId, candidate, now);
      await this.request(`${this.base}/points?wait=true`, "PUT", {
        points: [{ id: newId, vector, payload }],
      });
      await this.supersede(old, newId, now);
      this.lastError = null;
      return {
        ok: true,
        id: newId,
        operation: "created",
        memory: payload as unknown as MemoryRecord,
        superseded: [{ id: old.id, text: old.text }],
        message: `Eerder zei je "${old.text}", nu "${candidate.text}": bijgewerkt.`,
      };
    } catch (error) {
      this.lastError = messageOf(error);
      return { ok: false, error: this.lastError };
    } finally {
      this.endMutation();
    }
  }

  async list(limit = 50, offset?: unknown): Promise<MemoryListResponse> {
    if (!this.initialized && !this.embeddings.configured)
      return {
        memories: [],
        next: null,
        unavailable:
          "Embedding onboarding is required before creating a collection",
      };
    await this.init();
    const data = await this.request(`${this.base}/points/scroll`, "POST", {
      limit: Math.min(100, Math.max(1, limit)),
      with_payload: true,
      ...(offset ? { offset } : {}),
    });
    return {
      memories: data.result.points.map((point: Point) => ({
        id: point.id,
        ...point.payload,
      })),
      next: data.result.next_page_offset,
    };
  }

  /** Delete one record; with `history` also every record that was superseded into it. */
  async remove(
    id: string,
    options: { history?: boolean } = {},
  ): Promise<{ ok: true; removed?: number }> {
    if (!validMemoryId(id)) throw new Error("Invalid memory ID");
    if (!this.beginMutation())
      throw new Error("Memory index is rebuilding; retry shortly");
    try {
      await this.init();
      const ids = [id];
      if (options.history)
        ids.push(...ancestorsOf(id, await this.everything()));
      await this.request(`${this.base}/points/delete?wait=true`, "POST", {
        points: ids,
      });
      return { ok: true, removed: ids.length };
    } finally {
      this.endMutation();
    }
  }

  /** Archives memories of low importance that have not been used for 90 days. */
  async maintain(): Promise<Record<string, unknown>> {
    if (!this.beginMutation())
      return { ok: false, error: "Memory index is rebuilding; retry shortly" };
    try {
      await this.init();
      let offset: unknown;
      let archived = 0;
      let scanned = 0;
      do {
        const page = await this.list(100, offset);
        offset = page.next;
        for (const item of page.memories) {
          scanned++;
          if (
            !item.archived &&
            (item.importance ?? 1) < 0.4 &&
            Date.now() -
              Date.parse(item.last_accessed_at ?? item.updated_at ?? "") >
              90 * 86_400_000
          ) {
            await this.request(
              `${this.base}/points/payload?wait=true`,
              "POST",
              {
                points: [item.id],
                payload: {
                  archived: true,
                  archived_at: new Date().toISOString(),
                },
              },
            );
            archived++;
          }
        }
      } while (offset && scanned < 10_000);
      const consolidated = await this.consolidate();
      return {
        ok: true,
        scanned,
        archived,
        more: Boolean(offset),
        ...consolidated,
      };
    } finally {
      this.endMutation();
    }
  }

  /**
   * Deterministic housekeeping, no model calls: archive expired records, merge exact duplicates
   * and fold old episodes into one summary line per day. New rows are written before old ones go.
   */
  private async consolidate(): Promise<{
    expired: number;
    duplicatesMerged: number;
    episodesTrimmed: number;
  }> {
    const plan = planConsolidation(await this.everything());
    const now = new Date().toISOString();
    for (const id of plan.expire)
      await this.setPayload(id, { archived: true, archived_at: now });
    let duplicatesMerged = 0;
    for (const group of plan.duplicates) {
      await this.setPayload(group.keep, { access_count: group.accessCount });
      await this.request(`${this.base}/points/delete?wait=true`, "POST", {
        points: group.remove,
      });
      duplicatesMerged += group.remove.length;
    }
    let episodesTrimmed = 0;
    for (const day of plan.episodeDays) {
      const id = crypto.randomUUID();
      const vector = await this.embeddings.embed(day.text);
      await this.request(`${this.base}/points?wait=true`, "PUT", {
        points: [
          {
            id,
            vector,
            payload: {
              id,
              text: day.text,
              type: "CONVERSATION_SUMMARY",
              kind: "episode",
              origin: "tool",
              source: "scheduled_summary",
              importance: 0.4,
              confidence: 1,
              sensitive: false,
              consolidated: true,
              tags: [],
              related_entity: null,
              related_area: null,
              related_device: null,
              embedding_model: this.embeddings.model,
              created_at: `${day.day}T12:00:00.000Z`,
              updated_at: now,
              last_accessed_at: null,
              access_count: 0,
              archived: false,
              superseded_by: null,
              valid_until: null,
            },
          },
        ],
      });
      await this.request(`${this.base}/points/delete?wait=true`, "POST", {
        points: day.ids,
      });
      episodesTrimmed += day.ids.length;
    }
    return {
      expired: plan.expire.length,
      duplicatesMerged,
      episodesTrimmed,
    };
  }

  /** Build and verify a replacement off-path; switch only through a durable local pointer. */
  async reindex(): Promise<{
    ok: boolean;
    points?: number;
    collection?: string;
    warning?: string;
    error?: string;
  }> {
    if (!this.activeCollectionPath)
      return { ok: false, error: "Durable index switching is unavailable" };
    if (!this.embeddings.configured)
      return {
        ok: false,
        error: "Verified free embeddings are not configured",
      };
    if (this.reindexing || this.activeMutations > 0)
      return { ok: false, error: "Memory is busy; retry the reindex shortly" };
    this.reindexing = true;
    const source = this.activeCollectionName;
    const prefix = this.reindexedPrefix();
    const target = `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
    let targetCreated = false;
    let switched = false;
    let points = 0;
    try {
      await this.init();
      await this.request(`/collections/${target}`, "PUT", {
        vectors: { size: this.embeddings.dimensions, distance: "Cosine" },
      });
      targetCreated = true;
      for (const field of [
        "type",
        "archived",
        "related_entity",
        "embedding_model",
      ])
        await this.request(`/collections/${target}/index?wait=true`, "PUT", {
          field_name: field,
          field_schema: field === "archived" ? "bool" : "keyword",
        });

      let offset: unknown;
      do {
        const page = await this.request<{
          result?: { points?: unknown; next_page_offset?: unknown };
        }>(`/collections/${source}/points/scroll`, "POST", {
          limit: 100,
          with_payload: true,
          with_vector: false,
          ...(offset === undefined || offset === null ? {} : { offset }),
        });
        const rows = page.result?.points;
        if (!Array.isArray(rows))
          throw new Error("Qdrant returned an invalid scroll page");
        const batch = [];
        for (const row of rows) {
          if (
            !row ||
            typeof row !== "object" ||
            !("id" in row) ||
            !("payload" in row) ||
            !row.payload ||
            typeof row.payload !== "object" ||
            typeof (row.payload as Record<string, unknown>).text !== "string"
          )
            throw new Error("A memory record cannot be safely re-embedded");
          if (points >= 10_000)
            throw new Error("Memory index exceeds the 10,000 point safety cap");
          const payload = row.payload as Record<string, unknown>;
          const vector = await this.embeddings.embed(payload.text as string);
          batch.push({
            id: row.id,
            vector,
            payload: { ...payload, embedding_model: this.embeddings.model },
          });
          points++;
        }
        if (batch.length)
          await this.request(`/collections/${target}/points?wait=true`, "PUT", {
            points: batch,
          });
        offset = page.result?.next_page_offset;
        if (offset !== undefined && offset !== null && points >= 10_000)
          throw new Error("Memory index exceeds the 10,000 point safety cap");
      } while (offset !== undefined && offset !== null);

      const info = await this.request<{
        result?: {
          points_count?: unknown;
          config?: {
            params?: { vectors?: { size?: unknown; distance?: unknown } };
          };
        };
      }>(`/collections/${target}`);
      if (
        info.result?.points_count !== points ||
        info.result.config?.params?.vectors?.size !==
          this.embeddings.dimensions ||
        info.result.config?.params?.vectors?.distance !== "Cosine"
      )
        throw new Error("Replacement memory index did not verify");

      const revision: QdrantIndexRevision = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        before: source,
        after: target,
        points,
        embeddingModel: this.embeddings.model,
        dimensions: this.embeddings.dimensions,
      };
      this.persistActiveCollection(target, [...this.indexRevisions, revision]);
      this.initialized = true;
      this.lastError = null;
      switched = true;
      return { ok: true, points, collection: target };
    } catch (error) {
      const detail = messageOf(error);
      const safeErrors = [
        "Memory index exceeds the 10,000 point safety cap",
        "A memory record cannot be safely re-embedded",
        "Qdrant returned an invalid scroll page",
        "Replacement memory index did not verify",
        "The active Qdrant memory index is missing",
      ];
      this.lastError =
        safeErrors.find((message) => detail.includes(message)) ??
        (/^Qdrant unavailable \([1-5][0-9]{2}\)$/.test(detail)
          ? detail
          : "Qdrant memory reindex failed; the active index was preserved");
      if (this.activeCollectionName === target) {
        this.initialized = true;
        return {
          ok: true,
          points,
          collection: target,
          warning: "Index switched; directory durability check needs attention",
        };
      }
      if (targetCreated && !switched) {
        try {
          await this.request(`/collections/${target}`, "DELETE");
        } catch {
          // An unreachable Qdrant may leave an unused collection; the active pointer is unchanged.
        }
      }
      return { ok: false, error: this.lastError };
    } finally {
      this.reindexing = false;
    }
  }

  async rollbackIndex(revisionId: string): Promise<{
    ok: boolean;
    collection?: string;
    warning?: string;
    error?: string;
  }> {
    if (!/^[0-9a-f-]{36}$/i.test(revisionId))
      return { ok: false, error: "Ongeldige indexwijziging." };
    const revision = this.indexRevisions.find((item) => item.id === revisionId);
    if (!revision)
      return { ok: false, error: "Deze indexwijziging is niet beschikbaar." };
    if (revision.after !== this.activeCollectionName)
      return {
        ok: false,
        error:
          "De actieve index is daarna gewijzigd; terugzetten is afgebroken.",
      };
    if (
      revision.embeddingModel !== this.embeddings.model ||
      revision.dimensions !== this.embeddings.dimensions
    )
      return {
        ok: false,
        error:
          "De embeddinginstelling is gewijzigd; terugzetten is afgebroken.",
      };
    if (this.reindexing || this.activeMutations > 0)
      return {
        ok: false,
        error: "Geheugen is bezig; probeer het later opnieuw.",
      };
    this.reindexing = true;
    try {
      const info = await this.request<{
        result?: {
          points_count?: unknown;
          config?: {
            params?: { vectors?: { size?: unknown; distance?: unknown } };
          };
        };
      }>(`/collections/${revision.before}`);
      if (
        info.result?.points_count !== revision.points ||
        info.result.config?.params?.vectors?.size !==
          this.embeddings.dimensions ||
        info.result.config?.params?.vectors?.distance !== "Cosine"
      )
        return {
          ok: false,
          error:
            "De vorige index kon niet worden gecontroleerd; niets gewijzigd.",
        };
      const rollback: QdrantIndexRevision = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        before: this.activeCollectionName,
        after: revision.before,
        points: revision.points,
        embeddingModel: this.embeddings.model,
        dimensions: this.embeddings.dimensions,
      };
      this.persistActiveCollection(revision.before, [
        ...this.indexRevisions,
        rollback,
      ]);
      this.initialized = true;
      this.lastError = null;
      return { ok: true, collection: revision.before };
    } catch {
      if (this.activeCollectionName === revision.before) {
        this.initialized = true;
        return {
          ok: true,
          collection: revision.before,
          warning: "Index restored; directory durability check needs attention",
        };
      }
      return {
        ok: false,
        error: "Indexherstel is mislukt; de actieve index bleef behouden.",
      };
    } finally {
      this.reindexing = false;
    }
  }

  async health(): Promise<MemoryHealth> {
    let online = false;
    try {
      online = Boolean(await this.request("/"));
    } catch {
      /* Report unavailable without blocking chat. */
    }
    return {
      online,
      collection: this.collection,
      embeddings: {
        configured: this.embeddings.configured,
        model: this.embeddings.model || null,
        remoteOnly: true,
      },
      ready: online && this.embeddings.configured,
      error: this.lastError,
    };
  }
}
