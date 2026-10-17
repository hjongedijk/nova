import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import { NovaConfig } from "../core/config/nova-config.js";
import { writePrivateFile } from "./api-vault.js";
import type { ApiIntegration } from "./api.types.js";

/** apis.json (0600): learned specs and metadata. Never holds a credential, only vault references. */
@Injectable()
export class ApiRegistry {
  private readonly file: string;
  private data: Record<string, ApiIntegration> | null = null;
  /** Bumped whenever the learned specs change, so the tool list is rebuilt only then. */
  version = 0;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("apis.json");
  }

  private load(): Record<string, ApiIntegration> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        integrations?: Record<string, ApiIntegration>;
      };
      this.data = parsed.integrations ?? {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  list(): ApiIntegration[] {
    return Object.values(this.load());
  }

  get(id: string): ApiIntegration | undefined {
    return this.load()[id];
  }

  save(integration: ApiIntegration): void {
    this.load()[integration.id] = integration;
    this.flush();
    this.version++;
  }

  remove(id: string): ApiIntegration | undefined {
    const existing = this.load()[id];
    delete this.load()[id];
    if (existing) {
      this.flush();
      this.version++;
    }
    return existing;
  }

  flush(): void {
    writePrivateFile(
      this.file,
      JSON.stringify({ v: 1, integrations: this.load() }, null, 1),
    );
  }

  reload(): void {
    this.data = null;
    this.version++;
  }
}
