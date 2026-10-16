import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import type { OmniRouteComboUpdateHistoryEntry } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { REVISION_ID } from "./request-input.js";
import { sanitize } from "../core/security/sanitize.js";

const MAX_ENTRIES = 100;
type Entry = OmniRouteComboUpdateHistoryEntry & {
  beforeRevision: string;
  afterRevision: string;
};
const validId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const validModel = (value: unknown) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
  !/(^|\/)\.{1,2}(\/|$)/.test(value);
const safeName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 80 &&
  String(sanitize(value)) === value;

/** Bounded, private history of the editable, secret-free combo fields only. */
@Injectable()
export class OmniRouteComboUpdateHistory {
  private readonly history: HistoryFile<Entry>;
  constructor(config: NovaConfig) {
    this.history = new HistoryFile<Entry>(
      config.dataFile("omniroute-combo-update-history.json"),
      (row) => {
        const models = (value: unknown): value is string[] =>
          Array.isArray(value) &&
          value.length >= 1 &&
          value.length <= 8 &&
          value.every(validModel) &&
          new Set(value).size === value.length;
        if (
          !validId(row.comboId) ||
          !safeName(row.beforeName) ||
          !safeName(row.afterName) ||
          !models(row.beforeModels) ||
          !models(row.afterModels) ||
          typeof row.beforeRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.beforeRevision) ||
          typeof row.afterRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.afterRevision) ||
          (row.revertedFrom !== undefined &&
            (typeof row.revertedFrom !== "string" ||
              !REVISION_ID.test(row.revertedFrom)))
        )
          return undefined;
        return {
          comboId: row.comboId as string,
          beforeName: row.beforeName,
          afterName: row.afterName,
          beforeModels: [...row.beforeModels],
          afterModels: [...row.afterModels],
          beforeRevision: row.beforeRevision,
          afterRevision: row.afterRevision,
          ...revertedFromField(row),
        };
      },
      { max: MAX_ENTRIES, durability: "dir" },
    );
  }

  record(row: Omit<Entry, "id" | "at">): string | undefined {
    if (
      !validId(row.comboId) ||
      !safeName(row.beforeName) ||
      !safeName(row.afterName) ||
      row.beforeModels.length < 1 ||
      row.beforeModels.length > 8 ||
      row.afterModels.length < 1 ||
      row.afterModels.length > 8 ||
      !row.beforeModels.every(validModel) ||
      !row.afterModels.every(validModel) ||
      new Set(row.beforeModels).size !== row.beforeModels.length ||
      new Set(row.afterModels).size !== row.afterModels.length
    )
      return "Combo is gewijzigd, maar de wijziging is overgeslagen omdat veilige historie niet kon worden gemaakt.";
    try {
      this.history.write([
        ...this.history.all(),
        { ...row, id: crypto.randomUUID(), at: new Date().toISOString() },
      ]);
      return undefined;
    } catch {
      return "Combo is gecontroleerd, maar de wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
  }

  list(comboId: string) {
    if (!validId(comboId)) throw new NotFoundException("Combo niet gevonden.");
    return {
      revisions: this.history
        .all()
        .filter((row) => row.comboId === comboId)
        .slice(-20)
        .reverse()
        .map((row) => ({
          id: row.id,
          at: row.at,
          comboId: row.comboId as string,
          beforeName: row.beforeName,
          afterName: row.afterName,
          beforeModels: row.beforeModels,
          afterModels: row.afterModels,
          ...(row.revertedFrom ? { revertedFrom: row.revertedFrom } : {}),
        })),
    };
  }

  rollbackTarget(comboId: string, revisionId: string) {
    const rows = this.history.all().filter((row) => row.comboId === comboId);
    const row = rows.find((entry) => entry.id === revisionId);
    if (!row)
      throw new NotFoundException("Deze combo-wijziging bestaat niet meer.");
    if (rows.at(-1)?.id !== row.id)
      throw new NotFoundException(
        "Alleen de nieuwste combo-wijziging kan worden hersteld.",
      );
    return row;
  }
}
