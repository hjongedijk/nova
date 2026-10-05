import { Injectable } from "@nestjs/common";
import type { InstructionSkill, QuickAction } from "@nova/contracts";
import { SettingsStore } from "./store/settings.store.js";
import {
  formatPlaybooks,
  relevantPlaybooks,
  type StoredSkill,
} from "./skills/skills.js";

/**
 * What the chat needs from the user's settings: the playbooks that fit a request, the personal
 * rules and the quick actions. Read from the settings file on every call.
 */
@Injectable()
export class PlaybooksService {
  constructor(private readonly settings: SettingsStore) {}

  /** The enabled instruction skills that fit this message, best match first. */
  relevantPlaybooks(message: string, limit = 3): InstructionSkill[] {
    return relevantPlaybooks(
      message,
      this.settings.get().skills as unknown as StoredSkill[],
      limit,
    );
  }

  /** The text for the system prompt; empty when there is nothing to add. */
  formatPlaybooks(playbooks: InstructionSkill[]): string {
    return playbooks.length ? formatPlaybooks(playbooks) : "";
  }

  /** The playbooks for a message, ready for the system prompt ("" when none fit). */
  promptFor(message: string): string {
    return this.formatPlaybooks(this.relevantPlaybooks(message));
  }

  quickActions(): QuickAction[] {
    return this.settings.quickActions();
  }

  /** The user's own rules for NOVA ("" when none). */
  persona(): string {
    return this.settings.get().persona;
  }
}
