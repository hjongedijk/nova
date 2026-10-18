import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
  MemoryWriteResult,
} from "@nova/contracts";
import type { CandidateMetadata } from "./candidate.js";

/** A write result that can also say what it replaced (all extra fields are optional). */
export type MemoryWriteOutcome = MemoryWriteResult & {
  /** Sentence the model can relay, e.g. 'Eerder zei je X, nu Y: bijgewerkt.' */
  message?: string;
  superseded?: { id: string; text: string }[];
  conflictWith?: string;
  unchanged?: boolean;
};

/** A correction NOVA learned by itself is stored as an inferred memory with provenance tags. */
export interface CorrectionOptions {
  origin?: "inferred";
  tags?: string[];
}

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
  ): Promise<MemoryWriteOutcome>;
  list(limit?: number, offset?: unknown): Promise<MemoryListResponse>;
  /** `history` also deletes the records that were superseded into this one. */
  remove(
    id: string,
    options?: { history?: boolean },
  ): Promise<{ ok: true; removed?: number }>;
  /** Replace a record's text, keeping the old one as history. Optional per backend. */
  correct?(
    id: string,
    text: unknown,
    options?: CorrectionOptions,
  ): Promise<MemoryWriteOutcome>;
  maintain(): Promise<Record<string, unknown>>;
  health(): Promise<MemoryHealth>;
}

export const validMemoryId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
