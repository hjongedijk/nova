import { SemanticMemoryService } from "./semantic-memory.service.js";
import { memoryCandidate, MEMORY_TYPES } from "./semantic/candidate.js";
import {
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  isKind,
  type LifecycleRecord,
} from "./semantic/lifecycle.js";
import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolPlan,
  type ToolPlanError,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";

const safeErrors = new Set([
  "Invalid memory ID",
  "Memory is not owned by NOVA",
  "Memory rejected: not durable or contains secrets",
  "Memory index is rebuilding; retry shortly",
  "Verified free embeddings are not configured",
  "Long-term memory is not configured",
  "Memory not found",
]);

function safeMemoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  return typeof message === "string" && safeErrors.has(message)
    ? message
    : "Long-term memory is temporarily unavailable";
}

function publicRecord(record: LifecycleRecord) {
  return {
    id: record.id,
    text: record.text,
    kind: record.kind,
    type: record.type,
    origin: record.origin,
    confidence: record.confidence,
    sensitive: record.sensitive,
    created_at: record.created_at,
    updated_at: record.updated_at,
    last_accessed_at: record.last_accessed_at ?? null,
    superseded_by: record.superseded_by ?? null,
    valid_until: record.valid_until ?? null,
  };
}

/** memory_search/_remember/_list/_correct/_forget: NOVA's long-term memory as tools. */
@ToolSourceProvider()
export class MemorySource implements ToolSource {
  readonly source = "memory";

  constructor(private readonly memory: SemanticMemoryService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "memory_search",
        description:
          "Search durable semantic user memory. Returns unavailable when free remote embeddings are not configured.",
        parameters: schema({ query: text() }),
        risk: "READ_ONLY",
        timeoutMs: 15000,
      },
      {
        name: "memory_remember",
        description:
          "Store durable facts: what the user explicitly asked NOVA to remember (for example ‘Onthoud dat…’; include that prefix in text), or a clear durable preference/fact the owner stated by themselves (then set origin=inferred). Use PERSON/PET/HABIT/PROJECT/PREFERENCE when appropriate; never save secrets/transient state. Duplicates are merged; a changed fact (same subject, new value) replaces the old one and the result message says what changed, so relay it. Only when you are guessing (user did not say it), set origin=inferred: it is saved as an unconfirmed assumption and never overrides what the user said.",
        parameters: schema(
          {
            text: { type: "string", minLength: 5, maxLength: 2000 },
            type: { type: "string", enum: [...MEMORY_TYPES] },
            kind: { type: "string", enum: [...MEMORY_KINDS] },
            origin: { type: "string", enum: [...MEMORY_ORIGINS] },
            valid_until: text(40),
            related_entity: text(),
          },
          ["text"],
        ),
        risk: "SAFE",
        timeoutMs: 15000,
      },
      {
        name: "memory_list",
        description:
          "List what NOVA remembers, newest page first, with kind (fact/preference/decision/assumption/episode/project), confidence and origin. Optional filter by kind or text; pass next as offset for the following page. Superseded history only with include_history.",
        parameters: schema({
          kind: { type: "string", enum: [...MEMORY_KINDS] },
          search: text(),
          limit: integer(1, 50),
          offset: text(),
          include_history: { type: "boolean" },
        }),
        risk: "READ_ONLY",
        timeoutMs: 15000,
      },
      {
        name: "memory_correct",
        description:
          "Correct one memory by ID when the user says it is wrong: the new text replaces it and the old text is kept as superseded history. Get the ID from memory_search or memory_list.",
        parameters: schema({ id: text(), text: text(2000) }, ["id", "text"]),
        risk: "SAFE",
        timeoutMs: 15000,
      },
      {
        name: "memory_forget",
        description:
          "Delete exactly one semantic memory by ID. include_history=true also deletes the older versions that were replaced by it.",
        parameters: schema(
          { id: text(), include_history: { type: "boolean" } },
          ["id"],
        ),
        risk: "CONFIRM",
        timeoutMs: 15000,
      },
    ];
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPlan | ToolPlanError> {
    if (name === "memory_remember" && !memoryCandidate(args.text, args))
      return { error: "Memory rejected: not durable or contains secrets" };
    if (name === "memory_list" && args.kind !== undefined && !isKind(args.kind))
      return { error: "Invalid memory kind" };
    const risk =
      name === "memory_forget"
        ? "CONFIRM"
        : name === "memory_remember"
          ? "SAFE"
          : "READ_ONLY";
    return { args, risk };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (name === "memory_search") {
      try {
        const result = await this.memory.search(String(args.query));
        const ok = this.memory.configured && !this.memory.lastError;
        return {
          ok,
          result,
          ...(ok
            ? {}
            : {
                error: this.memory.configured
                  ? safeMemoryError(this.memory.lastError)
                  : "Long-term memory is not configured",
              }),
        };
      } catch (error) {
        return { ok: false, result: [], error: safeMemoryError(error) };
      }
    }
    if (name === "memory_remember") {
      try {
        const result = await this.memory.write(args.text, args);
        return result.ok
          ? { ...result }
          : { ok: false, error: safeMemoryError(result.error) };
      } catch (error) {
        return { ok: false, error: safeMemoryError(error) };
      }
    }
    if (name === "memory_list") {
      try {
        const page = await this.memory.listMemories({
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: args.offset === undefined ? undefined : String(args.offset),
          kind: isKind(args.kind) ? args.kind : undefined,
          search: typeof args.search === "string" ? args.search : undefined,
          includeHistory: args.include_history === true,
        });
        if (page.unavailable)
          return {
            ok: false,
            result: [],
            error: "Long-term memory is not configured",
          };
        return {
          ok: true,
          result: {
            memories: page.memories.map(publicRecord),
            next: page.next,
          },
        };
      } catch (error) {
        return { ok: false, result: [], error: safeMemoryError(error) };
      }
    }
    if (name === "memory_correct") {
      try {
        const result = await this.memory.correct(String(args.id), args.text);
        return result.ok
          ? { ...result }
          : { ok: false, error: safeMemoryError(result.error) };
      } catch (error) {
        return { ok: false, error: safeMemoryError(error) };
      }
    }
    if (name === "memory_forget") {
      try {
        return await this.memory.remove(String(args.id), {
          history: args.include_history === true,
        });
      } catch (error) {
        return { ok: false, error: safeMemoryError(error) };
      }
    }
    return { ok: false, error: `Unknown memory tool ${name}` };
  }
}
