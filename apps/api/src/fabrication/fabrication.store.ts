import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import type { FabricationFile } from "./fabrication.types.js";

const ID = /^[a-z0-9]{6,24}$/;

/**
 * fabrication.json holds designs (metadata and revisions) and print jobs; model files sit in
 * fabrication/<design>/r<n>.stl, the slice output in fabrication/jobs/<job>.<ext>. Everything is mode
 * 0600 and written atomically with fsync.
 */
@Injectable()
export class FabricationStore {
  private readonly log = new Logger("NOVA fabrication");
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("fabrication.json");
  }

  private dir(...parts: string[]): string {
    for (const part of parts)
      if (part !== "jobs" && !ID.test(part))
        throw new Error("Invalid path part");
    return this.config.dataFile(path.join("fabrication", ...parts));
  }

  load(): FabricationFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as FabricationFile;
      return {
        version: 1,
        designs: Array.isArray(parsed.designs) ? parsed.designs : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      };
    } catch {
      return { version: 1, designs: [], jobs: [] };
    }
  }

  /** Throws when the state cannot be made durable. */
  save(data: FabricationFile): void {
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
      this.log.warn("Could not save fabrication state");
      throw new Error("Could not save fabrication state");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  writeModel(designId: string, revision: number, data: Buffer): void {
    const file = this.modelPath(designId, revision);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: 0o600 });
  }

  readModel(designId: string, revision: number): Buffer | null {
    try {
      return fs.readFileSync(this.modelPath(designId, revision));
    } catch {
      return null;
    }
  }

  removeModel(designId: string, revision: number): void {
    fs.rmSync(this.modelPath(designId, revision), { force: true });
  }

  modelPath(designId: string, revision: number): string {
    if (!Number.isInteger(revision) || revision < 1)
      throw new Error("Invalid revision");
    return path.join(this.dir(designId), `r${revision}.stl`);
  }

  writeSlice(jobId: string, name: string, data: Buffer): void {
    const file = path.join(this.dir("jobs"), `${jobId}-${path.basename(name)}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: 0o600 });
  }

  readSlice(jobId: string, name: string): Buffer | null {
    try {
      return fs.readFileSync(
        path.join(this.dir("jobs"), `${jobId}-${path.basename(name)}`),
      );
    } catch {
      return null;
    }
  }
}
