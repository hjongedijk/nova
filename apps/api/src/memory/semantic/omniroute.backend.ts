import crypto from "node:crypto";
import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
  MemoryWriteResult,
} from "@nova/contracts";
import { sanitize } from "../../core/security/sanitize.js";
import type { OmniRouteManagement } from "../../routing/omniroute-management.service.js";
import { validMemoryId, type SemanticBackend } from "./backend.js";
import { memoryCandidate, type CandidateMetadata } from "./candidate.js";

/** The part of OmniRouteManagement this backend needs (so tests can pass a fake). */
export type MemoryManagementClient = Pick<
  OmniRouteManagement,
  "configured" | "scope" | "request" | "status"
>;

interface Row {
  id: string;
  key?: string;
  content: string;
  apiKeyId?: string;
  metadata?: {
    application?: string;
    nova?: Record<string, unknown>;
    jarvis?: Record<string, unknown>;
  };
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Long-term memory in OmniRoute's native memory (keyword search, no embeddings of our own).
 * Rows carry stable keys, belong to NOVA's API key and are checked for ownership on every read
 * and delete.
 */
export class OmniRouteMemory implements SemanticBackend {
  lastError: string | null = null;
  /** Availability does not depend on an embedding model: native FTS5 owns retrieval. */
  readonly embeddings = { configured: false, model: null };

  constructor(private readonly client: MemoryManagementClient) {}

  get configured(): boolean {
    return this.client.configured;
  }

  private owned(row: Row | undefined): row is Row {
    return (
      row?.apiKeyId === this.client.scope &&
      (row.metadata?.application === "nova" ||
        row.metadata?.application === "jarvis")
    );
  }

  private map(row: Row): MemoryRecord {
    return sanitize({
      ...(row.metadata?.application === "nova"
        ? row.metadata.nova
        : row.metadata?.jarvis),
      id: row.id,
      text: row.content,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    }) as MemoryRecord;
  }

  private async get(id: string): Promise<Row> {
    const data = await this.client.request<{ memory?: Row } & Row>(
      `/api/memory/${id}`,
    );
    return data.memory ?? data;
  }

  private async existing(
    hash: string,
    content: string,
  ): Promise<Row | undefined> {
    let total: number | undefined;
    let canonical: Row | undefined;
    let legacy: Row | undefined;
    const seen = new Set<string>();
    for (let offset = 0, page = 1; page <= 5; page++) {
      const query = new URLSearchParams({
        apiKeyId: this.client.scope,
        q: hash,
        limit: "100",
        offset: String(offset),
      });
      const result = await this.client.request<{
        data: Row[];
        total: number;
        page?: number;
        limit?: number;
        totalPages?: number;
      }>(`/api/memory?${query}`);
      if (
        !Array.isArray(result?.data) ||
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        result.total > 500 ||
        (total !== undefined && total !== result.total) ||
        result.data.length > 100 ||
        offset + result.data.length > result.total ||
        (result.page !== undefined && result.page !== page) ||
        (result.limit !== undefined && result.limit !== 100) ||
        (result.totalPages !== undefined &&
          result.totalPages !== Math.ceil(result.total / 100))
      )
        throw new Error("Invalid memory lookup pagination");
      total = result.total;
      for (const row of result.data) {
        if (
          !row ||
          typeof row !== "object" ||
          !validMemoryId(row.id) ||
          seen.has(row.id)
        )
          throw new Error("Invalid memory lookup row");
        seen.add(row.id);
        if (row.key !== `nova:${hash}` && row.key !== `jarvis:${hash}`)
          continue;
        if (
          !this.owned(row) ||
          !validMemoryId(row.id) ||
          typeof row.content !== "string" ||
          row.content.toLowerCase().replace(/\s+/g, " ").trim() !== content
        )
          throw new Error("Memory key collision");
        if (row.key === `nova:${hash}`) canonical ??= row;
        else legacy ??= row;
      }
      offset += result.data.length;
      if (offset === total) return canonical ?? legacy;
      if (!result.data.length || result.data.length !== 100)
        throw new Error("Incomplete memory lookup");
    }
    throw new Error("Truncated memory lookup");
  }

  async search(text: string, { limit = 6 } = {}): Promise<MemoryRecord[]> {
    if (!this.configured || typeof text !== "string" || !text.trim()) return [];
    try {
      const query = new URLSearchParams({
        apiKeyId: this.client.scope,
        q: sanitize(text).slice(0, 2000),
        limit: String(Math.min(20, Math.max(1, limit))),
      });
      const matches = await this.client.request<{ data?: Row[] }>(
        `/api/memory?${query}`,
      );
      const ownedMatches = (matches.data ?? []).filter((row) =>
        this.owned(row),
      );
      if (ownedMatches.length) {
        this.lastError = null;
        return ownedMatches.map((row) => this.map(row));
      }
      // Native "exact" is recent recall, used only when text search has no match.
      const data = await this.client.request<{ memories?: { id: string }[] }>(
        "/api/memory/retrieve-preview",
        {
          method: "POST",
          body: {
            query: sanitize(text).slice(0, 2000),
            strategy: "exact",
            maxTokens: 1200,
            apiKeyId: this.client.scope,
            limit: Math.min(20, Math.max(1, limit)),
          },
        },
      );
      const rows = await Promise.all(
        (data.memories ?? [])
          .slice(0, 20)
          .filter((row) => validMemoryId(row.id))
          .map((row) => this.get(row.id).catch(() => undefined)),
      );
      this.lastError = null;
      return rows.filter((row) => this.owned(row)).map((row) => this.map(row!));
    } catch {
      this.lastError = "Native memory retrieval unavailable";
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
      const normalized = candidate.text.toLowerCase().replace(/\s+/g, " ");
      const hash = crypto
        .createHash("sha256")
        .update(`${candidate.type}:${normalized}`)
        .digest("hex");
      const existing = await this.existing(hash, normalized);
      if (existing) {
        this.lastError = null;
        return {
          ok: true,
          id: existing.id,
          operation: "upserted",
          memory: this.map(existing),
          backend: "omniroute",
        };
      }
      const key = `nova:${hash}`;
      const created = await this.client.request<Row & { id: string | Row }>(
        "/api/memory",
        {
          method: "POST",
          body: {
            content: candidate.text,
            key,
            type: candidate.type === "PROCEDURE" ? "procedural" : "factual",
            apiKeyId: this.client.scope,
            metadata: { application: "nova", nova: candidate },
            expiresAt: null,
          },
        },
      );
      const row = (
        typeof created.id === "object" ? created.id : created
      ) as Row;
      if (
        !validMemoryId(row.id) ||
        !this.owned(row) ||
        row.metadata?.application !== "nova" ||
        row.key !== key ||
        typeof row.content !== "string" ||
        row.content.toLowerCase().replace(/\s+/g, " ").trim() !== normalized
      )
        throw new Error("Invalid memory ownership");
      this.lastError = null;
      return {
        ok: true,
        id: row.id,
        operation: "upserted",
        memory: this.map(row),
        backend: "omniroute",
      };
    } catch {
      this.lastError = "Native memory write unavailable";
      return { ok: false, error: this.lastError };
    }
  }

  async list(limit = 50, offset: unknown = 0): Promise<MemoryListResponse> {
    if (!this.configured)
      return {
        memories: [],
        unavailable: "OmniRoute management login is not configured",
      };
    const start = Math.max(0, Number(offset) || 0);
    const query = new URLSearchParams({
      apiKeyId: this.client.scope,
      limit: String(Math.min(100, Math.max(1, limit))),
      offset: String(start),
    });
    const data = await this.client.request<{ data?: Row[]; total?: number }>(
      `/api/memory?${query}`,
    );
    const rows = data.data ?? [];
    return {
      memories: rows
        .filter((row) => this.owned(row))
        .map((row) => this.map(row)),
      next:
        (data.total ?? 0) > start + rows.length ? start + rows.length : null,
      backend: "omniroute",
    };
  }

  async remove(id: string): Promise<{ ok: true }> {
    if (!validMemoryId(id)) throw new Error("Invalid memory ID");
    const row = await this.get(id);
    if (!this.owned(row)) throw new Error("Memory is not owned by NOVA");
    await this.client.request(`/api/memory/${id}`, { method: "DELETE" });
    return { ok: true };
  }

  async maintain(): Promise<{ ok: true; backend: string; archived: number }> {
    return { ok: true, backend: "omniroute", archived: 0 };
  }

  async health(): Promise<MemoryHealth> {
    const state = await this.client.status();
    return {
      online: state.online,
      ready: state.online && state.memory?.keyword === true,
      backend: "omniroute",
      retrieval: "keyword",
      embeddings: { configured: false, model: null, remoteOnly: true },
      error: state.online ? this.lastError : (state.error ?? null),
    };
  }
}
