import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../../core/config/nova-config.js";
import type { AutonomyFile, AutoTask } from "./autonomy.types.js";

/** autonomy-tasks.json (mode 0600), written atomically with fsync like the other state files. */
@Injectable()
export class AutonomyStore {
  private readonly log = new Logger("NOVA autonomy");
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("autonomy-tasks.json");
  }

  load(): AutoTask[] {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as AutonomyFile;
      return Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch {
      return [];
    }
  }

  /** Throws when the state cannot be made durable. */
  save(tasks: AutoTask[]): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: AutonomyFile = { version: 1, tasks };
      fs.writeFileSync(temporary, JSON.stringify(data, null, 1), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const descriptor = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
    } catch {
      this.log.warn("Could not save autonomous tasks");
      throw new Error("Could not save autonomous tasks");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
