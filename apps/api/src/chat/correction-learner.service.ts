import { Injectable } from "@nestjs/common";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import { contradicts } from "../memory/semantic/lifecycle.js";
import {
  detectCorrection,
  learnable,
  type CorrectionSignal,
} from "./correction.js";

export const LEARNED_TAGS = ["learned", "owner-correction"];

export interface LearnInput {
  sessionId: string;
  message: string;
  /** The last thing NOVA said: what the owner is reacting to. */
  previousAssistant?: string;
  /** Attachments, tool output or any other content the owner did not type themselves. */
  untrusted?: boolean;
}

export interface LearnOutcome {
  learned: boolean;
  signal: CorrectionSignal;
  superseded?: string;
}

type CorrectionListener = (event: {
  sessionId: string;
  signal: CorrectionSignal;
  previousAssistant?: string;
}) => void;

/**
 * Turns the owner's corrections into memory, by itself: "nee, mijn hond heet Max" supersedes the
 * wrong fact, "de grote lamp is light.woonkamer" becomes a LEARNED_ALIAS. Everything is stored as an
 * inferred memory (low confidence ceiling, provenance tags) through the same SAFE memory paths the
 * tools use. Secrets are never stored and untrusted turns never teach anything.
 */
@Injectable()
export class CorrectionLearner {
  private readonly listeners: CorrectionListener[] = [];

  constructor(
    private readonly config: NovaConfig,
    private readonly semantic: SemanticMemoryService,
    private readonly audit: AuditService,
  ) {}

  /** The autopilot listens for "doe dat niet meer" to tune itself. */
  onCorrection(listener: CorrectionListener): void {
    this.listeners.push(listener);
  }

  async learn(input: LearnInput): Promise<LearnOutcome | null> {
    if (input.untrusted) return null;
    const signal = detectCorrection(input.message);
    if (!signal) return null;
    for (const listener of this.listeners) {
      try {
        listener({
          sessionId: input.sessionId,
          signal,
          previousAssistant: input.previousAssistant,
        });
      } catch {
        /* a listener must never break the conversation */
      }
    }
    if (!this.config.autoExecuteSafe || !signal.statement) return null;
    if (!learnable(signal.statement)) return null;
    try {
      const outcome = await this.store(signal);
      this.audit.record({
        sessionId: input.sessionId,
        tool: "memory_learned",
        risk: "SAFE",
        confirmation: "owner_correction",
        result: {
          type: signal.type,
          learned: outcome.learned,
          alias: Boolean(signal.alias),
          superseded: outcome.superseded ?? null,
        },
      });
      return outcome;
    } catch {
      return { learned: false, signal };
    }
  }

  private async store(signal: CorrectionSignal): Promise<LearnOutcome> {
    const statement = signal.statement!;
    const metadata = {
      origin: "inferred" as const,
      type: signal.type,
      tags: LEARNED_TAGS,
      importance: 0.7,
      ...(signal.alias ? { related_entity: signal.alias.entity } : {}),
    };
    const wrong = signal.stop
      ? undefined
      : (await this.semantic.search(statement)).find(
          (record) =>
            !(record as { superseded_by?: string | null }).superseded_by &&
            contradicts(record.text, statement),
        );
    if (wrong) {
      const corrected = await this.semantic
        .correct(wrong.id, statement, {
          origin: "inferred",
          tags: LEARNED_TAGS,
        })
        .catch(() => null);
      if (corrected?.ok) return { learned: true, signal, superseded: wrong.id };
    }
    const written = await this.semantic.write(statement, metadata);
    return { learned: written.ok, signal };
  }
}
