import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  readStrictState,
  writeStrictState,
} from "../dashboard/strict-state-file.js";
import { normalizeHelperPreferences } from "../settings/settings-validation.js";
import { SettingsStore } from "../settings/store/settings.store.js";

const MAX_BYTES = 2048;
const TARGET = 100;
const UNAVAILABLE = "Conversation milestone unavailable";
interface Milestone {
  version: 1;
  turns: number;
  delivered: boolean;
}

/** Opt-in aggregate only: no text, identifiers, timestamps, or retrospective history. */
@Injectable()
export class ConversationMilestoneService {
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
  ) {
    this.file = config.dataFile("conversation-milestone.json");
  }

  private enabled(): boolean {
    return (
      normalizeHelperPreferences(
        this.settings.get().helperPreferences as unknown as Record<
          string,
          unknown
        >,
      ).rituals?.smallSurprises.enabled === true
    );
  }

  completedTurn(): void {
    try {
      if (!this.enabled()) return;
      const state = this.read();
      if (state.turns < TARGET)
        this.write({ ...state, turns: state.turns + 1 });
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }

  pending(): boolean {
    try {
      if (!this.enabled()) return false;
      const state = this.read();
      return state.turns === TARGET && !state.delivered;
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }

  delivered(): void {
    try {
      if (!this.enabled()) return;
      const state = this.read();
      if (state.turns === TARGET && !state.delivered)
        this.write({ ...state, delivered: true });
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }

  private read(): Milestone {
    return (
      readStrictState<Milestone>(
        this.file,
        MAX_BYTES,
        UNAVAILABLE,
        (state) =>
          Object.keys(state).sort().join(",") === "delivered,turns,version" &&
          state.version === 1 &&
          Number.isSafeInteger(state.turns) &&
          (state.turns as number) >= 0 &&
          (state.turns as number) <= TARGET &&
          typeof state.delivered === "boolean" &&
          !(state.delivered && state.turns !== TARGET),
      ) ?? { version: 1, turns: 0, delivered: false }
    );
  }

  private write(state: Milestone): void {
    writeStrictState(this.file, state);
  }
}
