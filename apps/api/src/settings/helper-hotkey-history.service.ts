import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  HelperHotkeyHistory as History,
  HelperHotkeyRevision,
  HelperHotkeys,
  HelperHotkeyRollbackResult,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import type { WallpaperPort } from "./wallpaper.port.js";

const keys = ["open", "speak", "mute", "desktop"] as const;
const normalize = (value: unknown): HelperHotkeys | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some(
      (key) =>
        typeof row[key] !== "string" ||
        (row[key] as string).length > 80 ||
        !row[key],
    )
  )
    return null;
  return {
    open: row.open as string,
    speak: row.speak as string,
    mute: row.mute as string,
    desktop: row.desktop as string,
  };
};

/** Private, bounded history for the four validated Windows helper shortcuts. */
@Injectable()
export class HelperHotkeyHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<HelperHotkeyRevision>;

  constructor(
    config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<HelperHotkeyRevision>(
      config.dataFile("helper-hotkey-history.json"),
      (row) => {
        const before = normalize(row.before);
        const after = normalize(row.after);
        return before && after
          ? { before, after, ...revertedFromField(row) }
          : undefined;
      },
      { durability: "file" },
    );
  }

  private auditChange(what: string, revision?: string): void {
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what, fields: keys, ...(revision ? { revision } : {}) },
        result: { ok: true },
      });
    } catch {
      throw new Error("audit unavailable");
    }
  }

  record(
    beforeValue: unknown,
    afterValue: unknown,
  ): { historyWarning?: string } | undefined {
    this.lastWarning = undefined;
    const before = normalize(beforeValue);
    const after = normalize(afterValue);
    if (!before || !after || isDeepStrictEqual(before, after)) return;
    const revision: HelperHotkeyRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
    };
    try {
      this.auditChange("helper_hotkeys_changed");
      this.history.append(revision);
      return;
    } catch {
      this.lastWarning =
        "Sneltoetsen zijn opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return { historyWarning: this.lastWarning };
    }
  }

  list(): History {
    const revisions = this.history.all();
    return {
      revisions: revisions.slice(-50),
      truncated: revisions.length > 50,
    };
  }

  async rollback(
    id: string,
    wallpaper?: WallpaperPort,
  ): Promise<HelperHotkeyRollbackResult> {
    const revision = this.history.all().find((entry) => entry.id === id);
    if (!revision)
      return {
        ok: false,
        error: "Deze sneltoetswijziging staat niet meer in de geschiedenis.",
      };
    if (!wallpaper?.helperPreferences)
      return { ok: false, error: "De Windows-agent is niet ingesteld." };
    let current;
    try {
      current = await wallpaper.helperPreferences();
    } catch {
      return { ok: false, error: "De Windows-agent is niet bereikbaar." };
    }
    const hotkeys = normalize(current.preferences?.hotkeys);
    if (!current.ok || !hotkeys)
      return {
        ok: false,
        error: "De huidige sneltoetsen konden niet worden gecontroleerd.",
      };
    if (!isDeepStrictEqual(hotkeys, revision.after))
      return {
        ok: false,
        error:
          "De sneltoetsen zijn intussen gewijzigd. Vernieuw de geschiedenis en probeer opnieuw.",
      };
    try {
      this.auditChange("helper_hotkeys_rollback_requested", id);
      const result = await wallpaper.helperPreferences(revision.before);
      const restored = normalize(result.preferences?.hotkeys);
      if (
        !result.ok ||
        !restored ||
        !isDeepStrictEqual(restored, revision.before)
      )
        return {
          ok: false,
          error:
            "De Windows-agent heeft het herstel niet bevestigd. Controleer de pc voordat je opnieuw probeert.",
        };
      const reverse: HelperHotkeyRevision = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        before: hotkeys,
        after: restored,
        revertedFrom: id,
      };
      let historyWarning: string | undefined;
      try {
        this.history.append(reverse);
      } catch {
        historyWarning =
          "Herstel is op de pc bevestigd, maar de geschiedenis kon niet worden bijgewerkt.";
      }
      return {
        ok: true,
        hotkeys: restored,
        warnings: (result.preferences?.warnings ?? []).slice(0, 5),
        ...(historyWarning ? { historyWarning } : {}),
      };
    } catch {
      return {
        ok: false,
        error:
          "Het herstel kon niet worden gelogd en is daarom niet uitgevoerd.",
      };
    }
  }
}
