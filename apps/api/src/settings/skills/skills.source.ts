import { createHash } from "node:crypto";
import path from "node:path";
import { Optional } from "@nestjs/common";
import { NovaConfig } from "../../core/config/nova-config.js";
import { schema, ToolSourceProvider } from "../../tools/tool.types.js";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolSource,
} from "../../tools/tool.types.js";
import { SettingsStore } from "../store/settings.store.js";
import { runSkill } from "./run-skill.js";
import { loadPluginSkills } from "./plugin-skills.js";
import {
  type StoredSkill,
  type StoredWebhookSkill,
  toolDefinition,
  toolNameFor,
} from "./skills.js";

/**
 * The webhook skills the user made on the settings screen, offered to the model as tools
 * named skill_<id>. They are read from the settings on every call, so a change on the
 * screen applies at once.
 */
@ToolSourceProvider()
export class SkillsSource implements ToolSource {
  readonly source = "skills";

  private readonly pluginSkills: StoredWebhookSkill[];

  constructor(
    private readonly settings: SettingsStore,
    @Optional() config?: NovaConfig,
  ) {
    this.pluginSkills = config
      ? loadPluginSkills(path.join(config.dataDir, "plugins"))
      : [];
  }

  private webhooks(): StoredWebhookSkill[] {
    const stored = this.settings.get().skills as unknown as StoredSkill[];
    const saved = stored.filter(
      (skill): skill is StoredWebhookSkill =>
        skill.type === "webhook" && skill.enabled,
    );
    const taken = new Set(stored.map((skill) => skill.id));
    return [
      ...saved,
      ...this.pluginSkills.filter(
        (skill) => skill.enabled && !taken.has(skill.id),
      ),
    ];
  }

  definitions(): ToolDefinition[] {
    return this.webhooks().map((skill) => {
      const tool = toolDefinition(skill);
      return {
        name: tool.name,
        approvalRevision: createHash("sha256")
          .update(JSON.stringify(skill))
          .digest("hex"),
        description: tool.description,
        parameters: {
          ...schema(tool.properties, tool.required),
          additionalProperties: false,
        },
        risk: tool.risk,
        timeoutMs: tool.timeout,
      };
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    const skill = this.webhooks().find((item) => toolNameFor(item) === name);
    if (!skill)
      return {
        ok: false,
        error: "Deze vaardigheid bestaat niet of staat uit.",
      };
    return { ...(await runSkill(skill, args ?? {}, call.signal)) };
  }
}
