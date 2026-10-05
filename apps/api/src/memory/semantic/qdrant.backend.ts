import crypto from "node:crypto";
import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
  MemoryWriteResult,
} from "@nova/contracts";
import { messageOf, validMemoryId, type SemanticBackend } from "./backend.js";
import { memoryCandidate, type CandidateMetadata } from "./candidate.js";

type Fetcher = typeof fetch;

export interface EmbeddingOptions {
  fetcher?: Fetcher;
  /** OmniRoute's OpenAI-compatible base URL (ends in /v1). */
  url: string;
  key: string;
  model: string;
  dimensions: number;
  freeVerified: boolean;
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
    const key = crypto.createHash("sha256").update(text).digest("hex");
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
        body: JSON.stringify({ model: this.model, input: text }),
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
  embeddings: RemoteEmbeddings;
}

const normalized = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Long-term memory in a Qdrant collection, found by cosine similarity on remote embeddings. */
export class QdrantMemory implements SemanticBackend {
  private readonly url: string;
  private readonly fetcher: Fetcher;
  readonly collection: string;
  readonly embeddings: RemoteEmbeddings;
  private initialized = false;
  lastError: string | null = null;

  constructor(private readonly options: QdrantOptions) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.collection))
      throw new Error("Invalid memory collection");
    this.url = options.url.replace(/\/$/, "");
    this.collection = options.collection;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.embeddings = options.embeddings;
  }

  get configured(): boolean {
    return this.embeddings.configured;
  }

  private get base(): string {
    return `/collections/${this.collection}`;
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
      const points = await this.nearest(
        await this.embeddings.embed(text),
        Math.min(20, Math.max(1, limit)),
      );
      const matches = points
        .filter((point) => point.score >= 0.65)
        .map((point) => {
          const ageDays =
            (Date.now() - Date.parse(point.payload.updated_at)) / 86_400_000;
          return {
            id: point.id,
            ...point.payload,
            score:
              point.score *
              (0.8 + 0.2 * point.payload.importance) *
              Math.max(0.7, 1 - ageDays / 3650),
          } as MemoryRecord;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (markAccess)
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
      this.lastError = null;
      return matches;
    } catch (error) {
      this.lastError = messageOf(error);
      return [];
    }
  }

  async write(
    text: unknown,
    metadata: CandidateMetadata = {},
  ): Promise<MemoryWriteResult> {
    const candidate = memoryCandidate(text, metadata);
    if (!candidate)
      return {
        ok: false,
        error: "Memory rejected: not durable or contains secrets",
      };
    try {
      await this.init();
      const vector = await this.embeddings.embed(candidate.text);
      const candidates = await this.nearest(vector);
      const existing = candidates.find(
        (point) =>
          point.payload.type === candidate.type &&
          (normalized(point.payload.text) === normalized(candidate.text) ||
            (point.score >= 0.97 &&
              point.payload.related_entity === candidate.related_entity)),
      );
      const now = new Date().toISOString();
      const id = existing?.id ?? crypto.randomUUID();
      const payload = {
        id,
        embedding_model: this.embeddings.model,
        ...candidate,
        created_at: existing?.payload.created_at ?? now,
        updated_at: now,
        last_accessed_at: existing?.payload.last_accessed_at ?? null,
        access_count: existing?.payload.access_count ?? 0,
        archived: false,
      };
      await this.request(`${this.base}/points?wait=true`, "PUT", {
        points: [{ id, vector, payload }],
      });
      this.lastError = null;
      return {
        ok: true,
        id,
        operation: existing ? "merged" : "created",
        memory: payload as MemoryRecord,
      };
    } catch (error) {
      this.lastError = messageOf(error);
      return { ok: false, error: this.lastError };
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

  async remove(id: string): Promise<{ ok: true }> {
    if (!validMemoryId(id)) throw new Error("Invalid memory ID");
    await this.request(`${this.base}/points/delete?wait=true`, "POST", {
      points: [id],
    });
    return { ok: true };
  }

  /** Archives memories of low importance that have not been used for 90 days. */
  async maintain(): Promise<{
    ok: true;
    scanned: number;
    archived: number;
    more: boolean;
  }> {
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
          await this.request(`${this.base}/points/payload?wait=true`, "POST", {
            points: [item.id],
            payload: { archived: true, archived_at: new Date().toISOString() },
          });
          archived++;
        }
      }
    } while (offset && scanned < 10_000);
    return { ok: true, scanned, archived, more: Boolean(offset) };
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
