import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WallpaperMode } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";

export interface WallpaperRevision {
  id: string;
  at: string;
  display: number;
  before: WallpaperMode;
  after: WallpaperMode;
  revertedFrom?: string;
}

const modes = ["full", "sphere", "off"];
const valid = (value: unknown): value is WallpaperMode =>
  typeof value === "string" && modes.includes(value);

/** Private, bounded history for safe Windows wallpaper mode changes. */
@Injectable()
export class WallpaperHistory {
  lastWarning: string | undefined;
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("wallpaper-history.json");
  }

  private read(): WallpaperRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const row = entry as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at)) ||
          !Number.isInteger(row.display) ||
          (row.display as number) < 0 ||
          (row.display as number) > 8 ||
          !valid(row.before) ||
          !valid(row.after)
        )
          return [];
        return [
          {
            id: row.id,
            at: new Date(row.at).toISOString(),
            display: row.display as number,
            before: row.before,
            after: row.after,
            ...(typeof row.revertedFrom === "string" &&
            /^[0-9a-f-]{36}$/i.test(row.revertedFrom)
              ? { revertedFrom: row.revertedFrom }
              : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private write(revisions: WallpaperRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(revisions.slice(-100)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  list() {
    const revisions = this.read();
    return {
      revisions: revisions.slice(-50).reverse(),
      truncated: revisions.length > 50,
    };
  }

  find(id: string): WallpaperRevision | undefined {
    return this.read().find((revision) => revision.id === id);
  }

  record(
    display: number,
    before: WallpaperMode,
    after: WallpaperMode,
    revertedFrom?: string,
  ): void {
    this.lastWarning = undefined;
    if (isDeepStrictEqual(before, after)) return;
    const revision: WallpaperRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      display,
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.write([...this.read(), revision]);
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: {
          what: "wallpaper",
          display,
          before,
          after,
          revision: revision.id,
        },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Achtergrond gewijzigd, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }
}
