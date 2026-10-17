import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  LIMITS,
  type Objective,
  type ObjectivesFile,
} from "./objectives.types.js";

export const emptyFile = (): ObjectivesFile => ({
  version: 1,
  objectives: [],
  settings: { dailyBudget: LIMITS.dailyBudget },
  usage: { day: "", notifications: 0 },
});

/** objectives.json (mode 0600), written atomically with fsync. */
@Injectable()
export class ObjectivesStore {
  private readonly log = new Logger("NOVA objectives");
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("objectives.json");
  }

  load(): ObjectivesFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as Partial<ObjectivesFile>;
      const budget = parsed.settings?.dailyBudget;
      return {
        version: 1,
        objectives: Array.isArray(parsed.objectives)
          ? (parsed.objectives.filter(
              (o) => o && typeof o.id === "string" && Array.isArray(o.checks),
            ) as Objective[])
          : [],
        settings: {
          dailyBudget:
            typeof budget === "number" && budget >= 1 && budget <= 100
              ? Math.round(budget)
              : LIMITS.dailyBudget,
        },
        usage:
          parsed.usage && typeof parsed.usage.day === "string"
            ? {
                day: parsed.usage.day,
                notifications: Number(parsed.usage.notifications) || 0,
              }
            : { day: "", notifications: 0 },
      };
    } catch {
      return emptyFile();
    }
  }

  save(data: ObjectivesFile): void {
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
      this.log.warn("could not save the objectives");
      throw new Error("Could not save the objectives");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
