import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OmniRouteActivationHistoryEntry } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";

const MAX_ENTRIES = 100;
type Row = OmniRouteActivationHistoryEntry & {
  kind: "account" | "combo" | "key";
  beforeRevision: string;
  afterRevision: string;
};

/** Private bounded history of upstream account activation; never stores provider credentials. */
@Injectable()
export class OmniRouteActivationHistory {
  private readonly file: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("omniroute-account-activation-history.json");
  }

  private read(): Row[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((item): Row[] => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return [];
          const row = item as Record<string, unknown>;
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            (row.kind !== "account" &&
              row.kind !== "combo" &&
              row.kind !== "key") ||
            typeof row.entityId !== "string" ||
            !/^[a-zA-Z0-9_.-]{1,100}$/.test(row.entityId) ||
            typeof row.name !== "string" ||
            row.name.length > 200 ||
            typeof row.beforeEnabled !== "boolean" ||
            typeof row.afterEnabled !== "boolean" ||
            row.beforeEnabled === row.afterEnabled ||
            typeof row.beforeRevision !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.beforeRevision) ||
            typeof row.afterRevision !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.afterRevision) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at))
          )
            return [];
          return [
            {
              id: row.id,
              kind: row.kind,
              entityId: row.entityId,
              name: String(sanitize(row.name)).slice(0, 200),
              beforeEnabled: row.beforeEnabled,
              afterEnabled: row.afterEnabled,
              beforeRevision: row.beforeRevision,
              afterRevision: row.afterRevision,
              at: new Date(row.at).toISOString(),
            },
          ];
        })
        .slice(-MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private write(rows: Row[]): void {
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

  record(
    row: Omit<Row, "id" | "at" | "kind"> & { kind?: Row["kind"] },
  ): string | undefined {
    if (row.beforeEnabled === row.afterEnabled) return;
    const entry: Row = {
      ...row,
      id: crypto.randomUUID(),
      kind: row.kind ?? "account",
      at: new Date().toISOString(),
    };
    try {
      this.write([...this.read(), entry]);
      return;
    } catch {
      return "De accountwijziging is gecontroleerd, maar de wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
  }

  list(
    entityId: string,
    kind: Row["kind"] = "account",
  ): { revisions: OmniRouteActivationHistoryEntry[] } {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(entityId))
      throw new ValidationError(["Ongeldig provideraccount."]);
    return {
      revisions: this.read()
        .filter((row) => row.entityId === entityId && row.kind === kind)
        .slice(-20)
        .reverse()
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          entityId: row.entityId,
          name: row.name,
          at: row.at,
          beforeEnabled: row.beforeEnabled,
          afterEnabled: row.afterEnabled,
        })),
    };
  }

  rollbackTarget(
    entityId: string,
    revisionId: string,
    kind: Row["kind"] = "account",
  ): { enabled: boolean; expectedCurrentRevision: string } {
    const rows = this.read();
    const entry = rows.find(
      (row) =>
        row.entityId === entityId && row.kind === kind && row.id === revisionId,
    );
    if (!entry)
      throw new NotFoundException("Deze wijziging bestaat niet meer.");
    const latest = [...rows]
      .reverse()
      .find((row) => row.entityId === entityId && row.kind === kind);
    if (latest?.id !== entry.id)
      throw new ValidationError([
        "Deze sleutel of dit account is later gewijzigd. Herstel alleen de nieuwste wijziging.",
      ]);
    return {
      enabled: entry.beforeEnabled,
      expectedCurrentRevision: entry.afterRevision,
    };
  }
}
