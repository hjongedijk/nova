import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  MemoryHealth,
  MemoryListResponse,
  MemoryRecord,
  MemoryWriteResult,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { messageOf, type SemanticBackend } from "./semantic/backend.js";
import type { CandidateMetadata } from "./semantic/candidate.js";
import { OmniRouteMemory } from "./semantic/omniroute.backend.js";
import { QdrantMemory, RemoteEmbeddings } from "./semantic/qdrant.backend.js";

const DAY = 86_400_000;

/** Stands in for a backend that cannot even be constructed (bad collection name, ...). */
class UnavailableMemory implements SemanticBackend {
  readonly configured = false;
  readonly embeddings = { configured: false, model: null };
  constructor(readonly lastError: string) {}
  async search(): Promise<MemoryRecord[]> {
    return [];
  }
  async write(): Promise<MemoryWriteResult> {
    return { ok: false, error: this.lastError };
  }
  async list(): Promise<MemoryListResponse> {
    return { memories: [], unavailable: this.lastError };
  }
  async remove(): Promise<{ ok: true }> {
    throw new Error(this.lastError);
  }
  async maintain(): Promise<Record<string, unknown>> {
    return { ok: false };
  }
  async health(): Promise<MemoryHealth> {
    return {
      online: false,
      ready: false,
      embeddings: { configured: false, model: null, remoteOnly: true },
      error: this.lastError,
    };
  }
}

/**
 * NOVA's long-term memory. Picks the backend from JARVIS_MEMORY_BACKEND (Qdrant with remote free
 * embeddings, or OmniRoute's native memory) and degrades like the prototype when it is not
 * configured: searches are empty, writes say why not, health reports it. Never crashes start-up.
 */
@Injectable()
export class SemanticMemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Memory");
  private timer: NodeJS.Timeout | null = null;
  private qdrantBackend: SemanticBackend | null = null;
  private omnirouteBackend: SemanticBackend | null = null;

  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
  ) {}

  /** For tests: replace one or both backends. */
  useBackends(backends: {
    qdrant?: SemanticBackend;
    omniroute?: SemanticBackend;
  }): void {
    if (backends.qdrant) this.qdrantBackend = backends.qdrant;
    if (backends.omniroute) this.omnirouteBackend = backends.omniroute;
  }

  /** The Qdrant backend (always available for its own health, even when OmniRoute is selected). */
  get qdrant(): SemanticBackend {
    if (!this.qdrantBackend) {
      try {
        this.qdrantBackend = new QdrantMemory({
          url: this.config.qdrantUrl,
          collection: this.config.qdrantCollection,
          apiKey: this.config.qdrantApiKey || undefined,
          embeddings: new RemoteEmbeddings({
            url: this.config.omniUrl,
            key: this.config.embeddingKey || this.config.omniKey,
            model: this.config.embeddingModel,
            dimensions: this.config.embeddingDimensions,
            freeVerified: this.config.embeddingFreeVerified,
          }),
        });
      } catch (error) {
        this.qdrantBackend = new UnavailableMemory(messageOf(error));
      }
    }
    return this.qdrantBackend;
  }

  private get omniroute(): SemanticBackend {
    return (this.omnirouteBackend ??= new OmniRouteMemory(this.management));
  }

  /** The selected backend. */
  get backend(): SemanticBackend {
    return this.config.memoryBackend === "omniroute"
      ? this.omniroute
      : this.qdrant;
  }

  get configured(): boolean {
    return this.backend.configured;
  }

  get lastError(): string | null {
    return this.backend.lastError;
  }

  search(
    text: string,
    options?: { limit?: number; markAccess?: boolean },
  ): Promise<MemoryRecord[]> {
    return this.backend.search(text, options);
  }

  write(
    text: unknown,
    metadata?: CandidateMetadata,
  ): Promise<MemoryWriteResult> {
    return this.backend.write(text, metadata);
  }

  list(limit?: number, offset?: unknown): Promise<MemoryListResponse> {
    return this.backend.list(limit, offset);
  }

  remove(id: string): Promise<{ ok: true }> {
    return this.backend.remove(id);
  }

  maintain(): Promise<Record<string, unknown>> {
    return this.backend.maintain();
  }

  /** Health of the selected backend (the dashboard's "longTermMemory"). */
  health(): Promise<MemoryHealth> {
    return this.backend.health();
  }

  /** Health of the Qdrant store itself (the dashboard's "qdrant"). */
  qdrantHealth(): Promise<MemoryHealth> {
    return this.qdrant.health();
  }

  /** One maintenance pass; never throws. */
  async runMaintenance(): Promise<void> {
    try {
      if (this.configured) await this.maintain();
    } catch {
      this.log.warn("Memory maintenance unavailable");
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runMaintenance(), DAY);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
