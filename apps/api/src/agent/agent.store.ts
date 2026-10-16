import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import type { AgentFile } from "./agent.types.js";

/** agent-runs.json (mode 0600), written atomically with fsync. */
@Injectable()
export class AgentStore {
  private readonly log = new Logger("NOVA agent");
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("agent-runs.json");
  }

  load(): AgentFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as AgentFile;
      return {
        version: 1,
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        usage:
          parsed.usage && typeof parsed.usage.day === "string"
            ? parsed.usage
            : { day: "", turns: 0 },
      };
    } catch {
      return { version: 1, runs: [], usage: { day: "", turns: 0 } };
    }
  }

  save(data: AgentFile): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data, null, 1), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } catch {
      this.log.warn("could not save the agent runs");
      throw new Error("Could not save the agent runs");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
