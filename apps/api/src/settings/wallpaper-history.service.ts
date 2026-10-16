import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WallpaperMode } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";

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
  private readonly history: HistoryFile<WallpaperRevision>;

  constructor(
    config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile(
      config.dataFile("wallpaper-history.json"),
      (row) =>
        Number.isInteger(row.display) &&
        (row.display as number) >= 0 &&
        (row.display as number) <= 8 &&
        valid(row.before) &&
        valid(row.after)
          ? {
              display: row.display as number,
              before: row.before,
              after: row.after,
              ...revertedFromField(row),
            }
          : undefined,
    );
  }

  list() {
    return this.history.list();
  }

  find(id: string): WallpaperRevision | undefined {
    return this.history.find(id);
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
      this.history.append(revision);
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
