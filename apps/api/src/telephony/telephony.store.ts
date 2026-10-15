import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { randomSecret } from "./asterisk-config.js";
import type { TelephonyConfig } from "./telephony.types.js";

export const defaultConfig = (): TelephonyConfig => ({
  version: 1,
  enabled: false,
  publicHost: "",
  ariSecret: randomSecret(),
  extensions: [],
  trunk: null,
  ringExtensions: [],
  allowInternalCallsWithoutConfirmation: false,
  voice: "edge",
});

/** telephony.json (0600, atomic + fsync). Holds the generated SIP and ARI secrets; never exposed over the API. */
@Injectable()
export class TelephonyStore {
  private readonly log = new Logger("NOVA telephony");
  private cache: TelephonyConfig | null = null;
  constructor(private readonly config: NovaConfig) {}

  get file(): string {
    return this.config.dataFile("telephony.json");
  }

  /** Directory mounted read-only into the Asterisk container (generated configuration). */
  get confDir(): string {
    return this.config.dataFile("asterisk/conf");
  }

  /** Directory shared with Asterisk for generated announcement audio. */
  get recordingDir(): string {
    return this.config.dataFile("asterisk/recordings");
  }

  get(): TelephonyConfig {
    if (this.cache) return this.cache;
    let loaded: Partial<TelephonyConfig> = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      /* first start: defaults with a freshly generated ARI secret */
    }
    this.cache = { ...defaultConfig(), ...loaded, version: 1 };
    if (!fs.existsSync(this.file)) this.save(this.cache);
    return this.cache;
  }

  save(next: TelephonyConfig): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next, null, 1), {
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
      this.cache = next;
    } catch {
      this.log.warn("Could not save telephony settings");
      throw new Error("Could not save telephony settings");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  update(change: (draft: TelephonyConfig) => void): TelephonyConfig {
    const draft = structuredClone(this.get());
    change(draft);
    this.save(draft);
    return draft;
  }

  /** Writes the generated Asterisk files atomically (0600). */
  writeConf(files: Record<string, string>): void {
    fs.mkdirSync(this.confDir, { recursive: true });
    // Created up front so Docker does not create the bind mount as root.
    fs.mkdirSync(path.join(this.recordingDir, "nova"), {
      recursive: true,
      mode: 0o755,
    });
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(this.confDir, name);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
    }
  }
}
