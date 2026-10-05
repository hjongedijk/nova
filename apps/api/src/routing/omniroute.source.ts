import { OmniRouteManagement } from "./omniroute-management.service.js";
import {
  schema,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
  ToolSourceProvider,
} from "../tools/tool.types.js";

/** Read-only tools about OmniRoute's own features. */
@ToolSourceProvider()
export class OmniRouteSource implements ToolSource {
  readonly source = "omniroute";

  constructor(private readonly management: OmniRouteManagement) {}

  definitions(): ToolDefinition[] {
    const enabled = this.management.configured;
    return [
      {
        name: "omniroute_status",
        description:
          "Read native OmniRoute memory, skill catalog, compression and cache status. Does not change settings.",
        parameters: schema(),
        risk: "READ_ONLY",
        timeoutMs: 15_000,
        enabled,
      },
      {
        name: "omniroute_agent_skills",
        description:
          "Read OmniRoute Agent Skills documentation metadata. This does not install or execute skills or grant extra permissions.",
        parameters: schema(
          { id: { type: "string", minLength: 1, maxLength: 200 } },
          [],
        ),
        risk: "READ_ONLY",
        timeoutMs: 15_000,
        enabled,
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (name === "omniroute_status") {
      const result = await this.management.status();
      return { ok: result.online === true, result };
    }
    return {
      ok: true,
      result: await this.management.skills(args.id as string | undefined),
    };
  }
}
