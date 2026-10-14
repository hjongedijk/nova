import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
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

function syncDirectory(file: string): void {
  const descriptor = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, turns: 0, delivered: false };
      throw error;
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) throw new Error(UNAVAILABLE);
    const descriptor = fs.openSync(
      this.file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_BYTES)
        throw new Error(UNAVAILABLE);
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(
          descriptor,
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES) throw new Error(UNAVAILABLE);
      const parsed: unknown = JSON.parse(
        bytes.subarray(0, length).toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(UNAVAILABLE);
      const state = parsed as Record<string, unknown>;
      if (
        Object.keys(state).sort().join(",") !== "delivered,turns,version" ||
        state.version !== 1 ||
        !Number.isSafeInteger(state.turns) ||
        (state.turns as number) < 0 ||
        (state.turns as number) > TARGET ||
        typeof state.delivered !== "boolean" ||
        (state.delivered && state.turns !== TARGET)
      )
        throw new Error(UNAVAILABLE);
      // Settle a rename that became visible before its directory-sync acknowledgement failed.
      fs.fsyncSync(descriptor);
      syncDirectory(this.file);
      return state as unknown as Milestone;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private write(state: Milestone): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(state));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
      syncDirectory(this.file);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Cleanup cannot authorize a failed or uncertain write.
      }
    }
  }
}
