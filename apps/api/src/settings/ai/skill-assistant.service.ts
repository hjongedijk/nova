import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SkillSuggestion } from "@nova/contracts";
import { ValidationError } from "../../core/errors/validation.error.js";
import { LLM_CLIENT, type LlmClient } from "../llm-client.js";
import {
  buildDraft,
  DRAFT_SYSTEM,
  type DraftResult,
  IMPROVE_SYSTEM,
  parseSuggestion,
} from "./skill-drafting.js";

/** NOVA proposes a better skill, or a first draft from the person's own words. */
@Injectable()
export class SkillAssistantService {
  constructor(
    @Optional() @Inject(LLM_CLIENT) private readonly llm?: LlmClient,
  ) {}

  async improveSkill({
    draft,
    goal,
    runs,
  }: {
    draft: Record<string, unknown>;
    goal: string;
    runs: unknown[];
  }): Promise<SkillSuggestion> {
    if (!this.llm) throw new Error("No LLM client available.");
    const user = JSON.stringify({
      concept: draft,
      doel: goal || undefined,
      recenteAanroepen: runs.length ? runs : undefined,
    });
    const answer = await this.llm.complete([
      { role: "system", content: IMPROVE_SYSTEM },
      { role: "user", content: user },
    ]);
    const suggestion = parseSuggestion(answer, draft);
    if (!Object.keys(suggestion.changes).length)
      return {
        ...suggestion,
        notes: suggestion.notes || "Ik zie niets dat beter kan.",
      };
    return suggestion;
  }

  async draftSkill({
    description,
  }: {
    description?: unknown;
  }): Promise<DraftResult> {
    const text = String(description ?? "").trim();
    if (text.length < 8)
      throw new ValidationError([
        "Vertel in een of twee zinnen wat NOVA moet kunnen.",
      ]);
    if (text.length > 1500)
      throw new ValidationError([
        "Dat is te lang. Hou het bij een paar zinnen.",
      ]);
    let raw = "";
    try {
      raw =
        (await this.llm?.complete([
          { role: "system", content: DRAFT_SYSTEM },
          { role: "user", content: text },
        ])) ?? "";
    } catch {
      /* the draft falls back to the person's own words */
    }
    return buildDraft(raw, text);
  }
}
