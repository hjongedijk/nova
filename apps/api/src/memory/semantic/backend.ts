import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
  MemoryWriteResult,
} from "@nova/contracts";
import type { CandidateMetadata } from "./candidate.js";

/** What a long-term memory store can do; Qdrant and OmniRoute's native memory both do it. */
export interface SemanticBackend {
  readonly configured: boolean;
  readonly lastError: string | null;
  readonly embeddings: { configured: boolean; model: string | null };
  search(
    text: string,
    options?: { limit?: number; markAccess?: boolean },
  ): Promise<MemoryRecord[]>;
  write(
    text: unknown,
    metadata?: CandidateMetadata,
  ): Promise<MemoryWriteResult>;
  list(limit?: number, offset?: unknown): Promise<MemoryListResponse>;
  remove(id: string): Promise<{ ok: true }>;
  maintain(): Promise<Record<string, unknown>>;
  health(): Promise<MemoryHealth>;
}

export const validMemoryId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
