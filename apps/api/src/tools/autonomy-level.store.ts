import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  type AutonomyLevel,
  DEFAULT_AUTONOMY_LEVEL,
  isAutonomyLevel,
} from "./autonomy-policy.js";

/** autonomy-level.json (mode 0600): the one setting that says how much NOVA does without asking. */
@Injectable()
export class AutonomyLevelStore {
  private readonly log = new Logger("NOVA autonomy level");
  private cached?: AutonomyLevel;
  constructor(private readonly config: NovaConfig) {}

  private get file(): string {
    return this.config.dataFile("autonomy-level.json");
  }

  get(): AutonomyLevel {
    if (this.cached) return this.cached;
    let level = DEFAULT_AUTONOMY_LEVEL;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        level?: unknown;
      };
      if (isAutonomyLevel(parsed.level)) level = parsed.level;
    } catch {
      /* not set yet: the default applies */
    }
    this.cached = level;
    return level;
  }

  set(level: AutonomyLevel): AutonomyLevel {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, level }), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
    } catch {
      this.log.warn("could not save the autonomy level");
      throw new Error("Could not save the autonomy level");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.cached = level;
    return level;
  }
}
