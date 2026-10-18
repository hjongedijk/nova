import crypto from "node:crypto";
import {
  schema,
  ToolSourceProvider,
  type ToolSource,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolPlan,
} from "../tools/tool.types.js";
import { SettingsStore } from "./store/settings.store.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import type { StoredSkill } from "./skills/skills.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object } from "./request-input.js";

const modelIdentifier = (value: unknown, model = false): string =>
  typeof value === "string" &&
  (model
    ? /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
      !/(^|\/)\.\.?(\/|$)/.test(value)
    : /^[a-zA-Z0-9_.-]{1,80}$/.test(value))
    ? value
    : "";

/** Explicit personal changes only. Credentials, services, access and executable skill bindings have no chat setter. */
@ToolSourceProvider()
export class SettingsSource implements ToolSource {
  readonly source = "settings";
  constructor(
    private readonly settings: SettingsStore,
    private readonly mutations: SettingsMutationsService,
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
  ) {}

  private get modelManagementAvailable(): boolean {
    return (
      this.config.extensionsEnabled &&
      this.config.omniUrl === this.config.verifiedOmniUrl &&
      this.management.configured
    );
  }

  definitions(): ToolDefinition[] {
    const current = this.settings.get();
    const revision = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          persona: current.persona,
          skills: current.skills,
          helperPreferences: current.helperPreferences,
        }),
      )
      .digest("hex");
    const definitions: ToolDefinition[] = [
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
          "Replace the user's personal conversation rules with the explicit requested text; empty text clears them. Never changes system safety rules or credentials.",
        parameters: schema({ text: { type: "string", maxLength: 2000 } }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
      {
        name: "settings_instruction_create",
        description:
          "Cannot add executable code, HTTP bindings, secrets or permissions.",
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
          "Webhook bindings can only be managed on the settings screen.",
        parameters: schema({
          id: { type: "string", minLength: 1, maxLength: 80 },
          enabled: { type: "boolean" },
        }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
      {
        name: "settings_helper_preference_set",
        description:
          "Change helper contrast, autohide, or whether sound cues are suppressed during the existing quiet-hours schedule. This does not change the schedule, volume, speech, device access, integrations, credentials or security settings.",
        parameters: schema({
          setting: {
            type: "string",
            enum: ["autohide", "contrast", "quietHours"],
          },
          enabled: { type: "boolean" },
        }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        approvalRevision: revision,
      },
    ];
    if (this.modelManagementAvailable)
      definitions.push({
        name: "settings_model_visibility",
        description:
          "This changes catalog visibility only, not whether direct requests are authorized; hiding can remove model aliases for that provider.",
        parameters: schema(
          {
            provider: { type: "string", minLength: 1, maxLength: 80 },
            modelId: { type: "string", minLength: 1, maxLength: 200 },
            hidden: { type: "boolean" },
          },
          ["provider", "modelId"],
        ),
        risk: "READ_ONLY",
        allowStandingApproval: false,
      });
    return definitions;
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPlan> {
    if (name !== "settings_model_visibility")
      return {
        args,
        risk: name === "settings_skills" ? "READ_ONLY" : "CONFIRM",
      };
    const provider = modelIdentifier(args.provider);
    const modelId = modelIdentifier(args.modelId, true);
    if (!provider || !modelId)
      return {
        args,
        risk: "READ_ONLY",
      };
    const state = await this.readModelState(provider, modelId);
    if (typeof args.hidden !== "boolean")
      return { args: { provider, modelId }, risk: "READ_ONLY", data: state };
    const hidden = state.hidden;
    const requested = args.hidden as boolean;
    return {
      args: { provider, modelId, hidden: requested, previouslyHidden: hidden },
      risk: hidden === requested ? "READ_ONLY" : "DANGEROUS",
      data: { hidden, requested },
    };
  }

  private async readModelState(
    provider: string,
    modelId: string,
    allowMissingFromCatalog = false,
  ): Promise<{ hidden: boolean }> {
    if (!this.modelManagementAvailable)
      throw new Error("OmniRoute modelbeheer is niet beschikbaar.");
    const report = object(
      await this.management.request(
        `/api/provider-models?provider=${encodeURIComponent(provider)}`,
      ),
    );
    const models = Array.isArray(report.models) ? report.models : [];
    const customModelExists = models.some((item) => {
      const row = object(item);
      return row.id === modelId || row.modelId === modelId;
    });
    const hiddenByProvider = object(report.hiddenModelsByProvider);
    const hiddenModels = Array.isArray(hiddenByProvider[provider])
      ? (hiddenByProvider[provider] as unknown[])
      : [];
    // provider-models lists only custom entries; built-in and synced models
    // live in the shared model catalog. Existing hidden entries remain valid
    // even when the upstream catalog no longer returns them.
    let catalogModelExists = false;
    if (
      !allowMissingFromCatalog &&
      !customModelExists &&
      !hiddenModels.includes(modelId)
    ) {
      const catalog = object(
        await this.management.request("/api/models/catalog"),
      );
      const providerCatalog = object(object(catalog.catalog)[provider]);
      const catalogModels = Array.isArray(providerCatalog.models)
        ? providerCatalog.models
        : [];
      catalogModelExists = catalogModels.some((item) => {
        const row = object(item);
        return row.id === modelId || row.modelId === modelId;
      });
    }
    if (
      !allowMissingFromCatalog &&
      !customModelExists &&
      !catalogModelExists &&
      !hiddenModels.includes(modelId)
    )
      throw new Error(
        "Dit model staat niet in de actuele OmniRoute-catalogus.",
      );
    return { hidden: hiddenModels.includes(modelId) };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall & { plan?: ToolPlan },
  ): Promise<ToolResult> {
    if (name === "settings_model_visibility") {
      const provider = modelIdentifier(args.provider);
      const modelId = modelIdentifier(args.modelId, true);
      const requested = args.hidden;
      const planned = call.plan?.data as
        { hidden?: boolean; requested?: boolean } | undefined;
      if (
        !provider ||
        !modelId ||
        !planned ||
        typeof planned.hidden !== "boolean"
      )
        return {
          ok: false,
          error: "Modelstatus is veranderd; vraag dit opnieuw.",
        };
      const current = await this.readModelState(provider, modelId);
      if (typeof requested !== "boolean")
        return {
          ok: true,
          verified: true,
          result: {
            provider,
            modelId,
            hidden: current.hidden,
            catalogOnly: true,
          },
        };
      if (planned.requested !== requested)
        return {
          ok: false,
          error: "Modelstatus is veranderd; vraag dit opnieuw.",
        };
      if (current.hidden !== planned.hidden)
        return {
          ok: false,
          error: "Modelstatus is veranderd; vraag dit opnieuw.",
        };
      if (current.hidden === requested)
        return {
          ok: true,
          verified: true,
          result: { provider, modelId, hidden: requested },
        };
      await this.management.request(
        `/api/provider-models?provider=${encodeURIComponent(provider)}&modelId=${encodeURIComponent(modelId)}`,
        { method: "PATCH", body: { isHidden: requested } },
      );
      // The confirmed model may disappear from the catalog and hidden map
      // after being restored; absence from hidden state is authoritative.
      const after = await this.readModelState(provider, modelId, true);
      if (after.hidden !== requested)
        throw new Error("Modelstatus kon niet worden gecontroleerd.");
      return {
        ok: true,
        verified: true,
        result: {
          provider,
          modelId,
          hidden: requested,
          catalogOnly: true,
          aliasesMayChange: true,
        },
      };
    }
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
    if (name === "settings_helper_preference_set") {
      if (
        (args.setting !== "autohide" &&
          args.setting !== "contrast" &&
          args.setting !== "quietHours") ||
        typeof args.enabled !== "boolean"
      )
        return {
          ok: false,
          error: "Kies een geldige helperweergave-instelling.",
        };
      return {
        ok: true,
        verified: true,
        result: this.mutations.setHelperPreference(
          args.setting,
          args.enabled,
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
