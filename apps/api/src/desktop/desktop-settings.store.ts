import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import type { DesktopSettings } from "./desktop.types.js";

const DEFAULTS: DesktopSettings = {
  viewEnabled: true,
  controlEnabled: true,
  cacheEnabled: true,
};

/** desktop-settings.json (0600). PC access follows pairing; legacy permission flags are ignored. */
@Injectable()
export class DesktopSettingsStore {
  private readonly log = new Logger("NOVA desktop");
  constructor(private readonly config: NovaConfig) {}

  private get file() {
    return this.config.dataFile("desktop-settings.json");
  }

  get(): DesktopSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<
        string,
        unknown
      >;
      return {
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: raw.cacheEnabled !== false,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** Throws when the change cannot be saved, so the caller never claims it took effect. */
  set(patch: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.get() };
    if (typeof patch.cacheEnabled === "boolean")
      next.cacheEnabled = patch.cacheEnabled;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      this.log.warn("Could not save desktop settings");
      throw new Error("Could not save desktop settings");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return next;
  }
}
