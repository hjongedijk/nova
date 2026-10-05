/** A long-term memory as the API returns it (Qdrant payload or OmniRoute row, mapped). */
export interface MemoryRecord {
  id: string;
  text: string;
  type?: string;
  source?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  related_entity?: string | null;
  related_area?: string | null;
  related_device?: string | null;
  created_at?: string;
  updated_at?: string;
  last_accessed_at?: string | null;
  access_count?: number;
  archived?: boolean;
  /** Search relevance, only on search results. */
  score?: number;
}

/** GET /api/memories */
export interface MemoryListResponse {
  memories: MemoryRecord[];
  next?: string | number | null;
  backend?: string;
  unavailable?: string;
}

/** POST /api/memories/search */
export interface MemorySearchResponse {
  memories: MemoryRecord[];
  configured: boolean;
}

/** POST /api/memories (memory_remember) */
export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
  id?: string;
  operation?: "created" | "merged" | "upserted";
  memory?: MemoryRecord;
  backend?: string;
  requiresConfirmation?: boolean;
}

/** Health of one memory backend, shown on the dashboard. */
export interface MemoryHealth {
  online: boolean;
  ready: boolean;
  collection?: string;
  backend?: string;
  retrieval?: string;
  embeddings: { configured: boolean; model: string | null; remoteOnly: true };
  error: string | null;
}

/** GET /api/memory/:sessionId */
export interface SessionMemoryResponse {
  sessionId: string;
  count: number;
  messages: { role: "user" | "assistant"; content: string; at: string }[];
}
