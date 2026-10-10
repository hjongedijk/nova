import crypto from "node:crypto";
import {
  schema,
  ToolSourceProvider,
  type ToolSource,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
} from "../tools/tool.types.js";
import { SettingsStore } from "./store/settings.store.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import type { StoredSkill } from "./skills/skills.js";

/** Explicit personal changes only. Credentials, services, access and executable skill bindings have no chat setter. */
@ToolSourceProvider()
export class SettingsSource implements ToolSource {
  readonly source = "settings";
  constructor(
    private readonly settings: SettingsStore,
    private readonly mutations: SettingsMutationsService,
  ) {}

  definitions(): ToolDefinition[] {
    const current = this.settings.get();
    const revision = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ persona: current.persona, skills: current.skills }),
      )
      .digest("hex");
    return [
      {
        name: "settings_skills",
        description:
          "List personal skill identifiers, names, types, enabled state and versions. No credentials or HTTP bindings.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "settings_persona_set",
        description:
          "Replace the user's personal conversation rules with the explicit requested text; empty text clears them. Always asks for fresh confirmation. Never changes system safety rules or credentials.",
        parameters: schema({ text: { type: "string", maxLength: 2000 } }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
      {
        name: "settings_instruction_create",
        description:
          "Create a personal instruction playbook using existing tools, after fresh confirmation. Cannot add executable code, HTTP bindings, secrets or permissions.",
        parameters: schema(
          {
            name: { type: "string", minLength: 2, maxLength: 60 },
            instructions: { type: "string", minLength: 1, maxLength: 4000 },
            description: { type: "string", maxLength: 300 },
            examples: {
              type: "array",
              maxItems: 8,
              items: { type: "string", maxLength: 120 },
            },
          },
          ["name", "instructions"],
        ),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
      {
        name: "settings_skill_toggle",
        description:
          "Enable or disable an existing personal instruction skill by ID, after fresh confirmation. Webhook bindings can only be managed on the settings screen.",
        parameters: schema({
          id: { type: "string", minLength: 1, maxLength: 80 },
          enabled: { type: "boolean" },
        }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    const skills = this.settings.get().skills as unknown as StoredSkill[];
    if (name === "settings_skills")
      return {
        ok: true,
        result: {
          skills: skills.map(({ id, name, type, enabled, version }) => ({
            id,
            name,
            type,
            enabled,
            version,
          })),
        },
      };
    const origin = {
      sessionId: call.sessionId,
      confirmation: "confirmed_tool" as const,
    };
    if (name === "settings_persona_set")
      return {
        ok: true,
        verified: true,
        result: this.mutations.setPersona(args.text, origin),
      };
    if (name === "settings_instruction_create")
      return {
        ok: true,
        verified: true,
        result: this.mutations.createSkill(
          {
            type: "instruction",
            name: args.name,
            instructions: args.instructions,
            description: args.description,
            examples: args.examples,
            enabled: true,
          },
          origin,
        ),
      };
    if (name === "settings_skill_toggle") {
      const skill = skills.find((item) => item.id === args.id);
      if (!skill || skill.type !== "instruction")
        return {
          ok: false,
          error:
            "Kies een bestaande instructie. Aanroepen naar diensten beheer je in Instellingen.",
        };
      return {
        ok: true,
        verified: true,
        result: this.mutations.updateSkill(
          skill.id,
          { ...skill, enabled: args.enabled },
          origin,
        ),
      };
    }
    return {
      ok: false,
      error:
        "Deze instelling kan alleen op het instellingenscherm worden gewijzigd.",
    };
  }
}
