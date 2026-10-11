import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OmniRouteComboUpdateHistoryEntry } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
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
  private readonly file: string;
  constructor(config: NovaConfig) {
    this.file = config.dataFile("omniroute-combo-update-history.json");
  }

  private read(): Entry[] {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw
        .flatMap((item): Entry[] => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return [];
          const row = item as Record<string, unknown>;
          const models = (value: unknown): value is string[] =>
            Array.isArray(value) &&
            value.length >= 1 &&
            value.length <= 8 &&
            value.every(validModel) &&
            new Set(value).size === value.length;
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            !validId(row.comboId) ||
            !safeName(row.beforeName) ||
            !safeName(row.afterName) ||
            !models(row.beforeModels) ||
            !models(row.afterModels) ||
            typeof row.beforeRevision !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.beforeRevision) ||
            typeof row.afterRevision !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.afterRevision) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            (row.revertedFrom !== undefined &&
              (typeof row.revertedFrom !== "string" ||
                !/^[0-9a-f-]{36}$/i.test(row.revertedFrom)))
          )
            return [];
          return [
            {
              id: row.id as string,
              comboId: row.comboId as string,
              beforeName: row.beforeName as string,
              afterName: row.afterName as string,
              beforeModels: [...(row.beforeModels as string[])],
              afterModels: [...(row.afterModels as string[])],
              beforeRevision: row.beforeRevision as string,
              afterRevision: row.afterRevision as string,
              at: new Date(row.at).toISOString(),
              ...(typeof row.revertedFrom === "string"
                ? { revertedFrom: row.revertedFrom }
                : {}),
            },
          ];
        })
        .slice(-MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private write(rows: Entry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fs.writeFileSync(temp, JSON.stringify(rows.slice(-MAX_ENTRIES)), {
        mode: 0o600,
      });
      fs.chmodSync(temp, 0o600);
      fd = fs.openSync(temp, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
      const dir = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
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
      this.write([
        ...this.read(),
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
      revisions: this.read()
        .filter((row) => row.comboId === comboId)
        .slice(-20)
        .reverse()
        .map((row) => ({
          id: row.id,
          at: row.at,
          comboId: row.comboId,
          beforeName: row.beforeName,
          afterName: row.afterName,
          beforeModels: row.beforeModels,
          afterModels: row.afterModels,
          ...(row.revertedFrom ? { revertedFrom: row.revertedFrom } : {}),
        })),
    };
  }

  rollbackTarget(comboId: string, revisionId: string) {
    const rows = this.read().filter((row) => row.comboId === comboId);
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
