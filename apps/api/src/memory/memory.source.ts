import { SemanticMemoryService } from "./semantic-memory.service.js";
import { memoryCandidate, MEMORY_TYPES } from "./semantic/candidate.js";
import {
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolPlan,
  type ToolPlanError,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { messageOf } from "./semantic/backend.js";

/** memory_search, memory_remember and memory_forget: NOVA's long-term memory as tools. */
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
          "Store an explicit durable fact or preference. Secrets and transient state are rejected.",
        parameters: schema(
          {
            text: { type: "string", minLength: 5, maxLength: 2000 },
            type: { type: "string", enum: [...MEMORY_TYPES] },
            related_entity: text(),
          },
          ["text"],
        ),
        risk: "SAFE",
        timeoutMs: 15000,
      },
      {
        name: "memory_forget",
        description:
          "Delete exactly one semantic memory by ID. Requires confirmation.",
        parameters: schema({ id: text() }),
        risk: "CONFIRM",
        timeoutMs: 15000,
      },
    ];
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPlan | ToolPlanError> {
    if (
      name === "memory_remember" &&
      !memoryCandidate(args.text, { ...args, explicit: true })
    )
      return { error: "Memory rejected: not durable or contains secrets" };
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
      const result = await this.memory.search(String(args.query));
      const ok = this.memory.configured && !this.memory.lastError;
      return {
        ok,
        result,
        ...(ok
          ? {}
          : {
              error:
                this.memory.lastError || "Long-term memory is not configured",
            }),
      };
    }
    if (name === "memory_remember")
      return {
        ...(await this.memory.write(args.text, { ...args, explicit: true })),
      };
    if (name === "memory_forget") {
      try {
        return await this.memory.remove(String(args.id));
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    }
    return { ok: false, error: `Unknown memory tool ${name}` };
  }
}
