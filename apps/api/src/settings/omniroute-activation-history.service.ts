import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import type { OmniRouteActivationHistoryEntry } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile } from "./history-file.js";
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
  private readonly history: HistoryFile<Row>;

  constructor(config: NovaConfig) {
    this.history = new HistoryFile<Row>(
      config.dataFile("omniroute-account-activation-history.json"),
      (row) => {
        if (
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
          !/^[a-f0-9]{64}$/.test(row.afterRevision)
        )
          return undefined;
        return {
          kind: row.kind,
          entityId: row.entityId,
          name: String(sanitize(row.name)).slice(0, 200),
          beforeEnabled: row.beforeEnabled,
          afterEnabled: row.afterEnabled,
          beforeRevision: row.beforeRevision,
          afterRevision: row.afterRevision,
        };
      },
      { max: MAX_ENTRIES, durability: "dir" },
    );
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
      this.history.append(entry);
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
      revisions: this.history
        .all()
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
    const rows = this.history.all();
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
