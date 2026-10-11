import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ServiceConnection,
  ServiceConnectionRevision,
} from "@nova/contracts";
import { NovaConfig } from "../../core/config/nova-config.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ValidationError } from "../../core/errors/validation.error.js";
import {
  CONNECTIONS,
  connectionDefaults,
  connectionFile,
  connectionSpec,
  displayUrl,
  normalizeConnection,
  readConnections,
  type ConnectionFile,
  type ConnectionValues,
} from "../../core/config/service-connections.js";

export type BackupConnections = Record<
  string,
  Record<string, string | boolean>
>;
const backupField = (field: { key: string; kind: string }) =>
  field.kind !== "secret" && field.key !== "username";

@Injectable()
export class ServiceConnectionsStore {
  auditWarning: string | undefined;
  private readonly running: Record<string, ConnectionValues>;
  constructor(
    private readonly config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.running = connectionDefaults(config);
  }

  effective(id: string): ConnectionValues {
    connectionSpec(id);
    return {
      ...this.running[id],
      ...readConnections(this.config.dataDir).services[id],
    };
  }

  list(): ServiceConnection[] {
    const stored = readConnections(this.config.dataDir).services;
    return CONNECTIONS.map((spec) => {
      const values = { ...this.running[spec.id], ...stored[spec.id] };
      return {
        id: spec.id,
        label: spec.label,
        restartRequired: spec.fields.some(
          (field) => values[field.key] !== this.running[spec.id]?.[field.key],
        ),
        fields: spec.fields.map((field) => ({
          ...field,
          source: Object.hasOwn(stored[spec.id] ?? {}, field.key)
            ? "settings"
            : "environment",
          ...(field.kind === "secret"
            ? { set: Boolean(values[field.key]) }
            : {
                value:
                  field.kind === "url"
                    ? displayUrl(String(values[field.key] ?? ""))
                    : (values[field.key] ?? ""),
              }),
        })),
      };
    });
  }

  /** Export connection destinations and harmless options; credential values stay local. */
  backupValues(): BackupConnections {
    return Object.fromEntries(
      CONNECTIONS.map((spec) => {
        const values = this.effective(spec.id);
        return [
          spec.id,
          Object.fromEntries(
            spec.fields
              .filter(backupField)
              .map((field) => [
                field.key,
                field.kind === "url"
                  ? displayUrl(String(values[field.key] ?? ""))
                  : (values[field.key] ?? ""),
              ]),
          ),
        ];
      }),
    );
  }

  /** Validate a full exported connection map and preserve destination credentials. */
  prepareBackup(
    value: unknown,
    mode: "merge" | "replace",
  ): {
    next: ConnectionFile;
    changes: {
      service: string;
      before: Record<string, string | boolean>;
      after: Record<string, string | boolean>;
    }[];
  } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError(["De back-up bevat ongeldige koppelingen."]);
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== CONNECTIONS.length)
      throw new ValidationError(["De back-up mist koppelingen."]);
    const incoming = new Map<string, ConnectionValues>();
    for (const spec of CONNECTIONS) {
      const raw = input[spec.id];
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ValidationError(["De back-up bevat ongeldige koppelingen."]);
      const fields = raw as Record<string, unknown>;
      const publicFields = spec.fields.filter(backupField);
      if (
        Object.keys(fields).length !== publicFields.length ||
        publicFields.some((field) => !Object.hasOwn(fields, field.key))
      )
        throw new ValidationError([
          "De back-up bevat onvolledige of geheime koppelingsvelden.",
        ]);
      const normalized = normalizeConnection(spec.id, fields);
      if (Object.keys(normalized).length !== publicFields.length)
        throw new ValidationError([
          "Geheime koppelingsvelden mogen niet in een back-up staan.",
        ]);
      incoming.set(spec.id, normalized);
    }

    const current = readConnections(this.config.dataDir);
    const changes: {
      service: string;
      before: Record<string, string | boolean>;
      after: Record<string, string | boolean>;
    }[] = [];
    const nextServices: Record<string, ConnectionValues> =
      mode === "merge" ? structuredClone(current.services) : {};
    for (const spec of CONNECTIONS) {
      const oldStored = current.services[spec.id] ?? {};
      const keptCredentials = Object.fromEntries(
        spec.fields
          .filter(
            (field) => field.kind === "secret" || field.key === "username",
          )
          .flatMap((field) =>
            oldStored[field.key] === undefined
              ? []
              : [[field.key, oldStored[field.key]!]],
          ),
      );
      const before = this.effective(spec.id);
      const overrides = nextServices[spec.id] ?? {};
      const merged = {
        ...overrides,
        ...keptCredentials,
        ...incoming.get(spec.id),
      };
      const after = { ...this.running[spec.id], ...merged };
      const publicValues = (values: ConnectionValues) =>
        this.publicValues(spec.id, values);
      const publicBefore = publicValues(before);
      const publicAfter = publicValues(after);
      if (JSON.stringify(publicBefore) !== JSON.stringify(publicAfter)) {
        changes.push({
          service: spec.id,
          before: publicBefore,
          after: publicAfter,
        });
        current.history.push({
          id: crypto.randomUUID(),
          service: spec.id,
          at: new Date().toISOString(),
          before: publicValues(before),
          after: publicValues(after),
          secretChanges: [],
        });
      }
      nextServices[spec.id] = merged;
    }
    const next: ConnectionFile = {
      version: 1,
      services: nextServices,
      history: current.history.slice(-100),
    };
    return { next, changes };
  }

  /** A private detached copy for transactional import recovery. */
  snapshot(): ConnectionFile {
    return structuredClone(readConnections(this.config.dataDir));
  }

  restoreSnapshot(snapshot: ConnectionFile): void {
    if (
      snapshot?.version !== 1 ||
      !snapshot.services ||
      typeof snapshot.services !== "object" ||
      Array.isArray(snapshot.services) ||
      !Array.isArray(snapshot.history)
    )
      throw new ValidationError([
        "Herstelbestand voor koppelingen is ongeldig.",
      ]);
    const services = Object.fromEntries(
      Object.entries(snapshot.services).map(([id, values]) => [
        id,
        normalizeConnection(id, values),
      ]),
    );
    const file = connectionFile(this.config.dataDir);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          { version: 1, services, history: snapshot.history.slice(-100) },
          null,
          2,
        ),
        {
          mode: 0o600,
        },
      );
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      const directory = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  candidate(
    id: string,
    input: unknown,
    clearSecrets?: unknown,
  ): ConnectionValues {
    const spec = connectionSpec(id);
    const patch = normalizeConnection(id, input);
    const next = this.effective(id);
    for (const [key, value] of Object.entries(patch)) {
      const field = spec.fields.find((item) => item.key === key)!;
      if (field.kind === "secret" && value === "") continue;
      next[key] = value;
    }
    if (clearSecrets !== undefined) {
      if (
        !Array.isArray(clearSecrets) ||
        clearSecrets.length > spec.fields.length ||
        clearSecrets.some(
          (key) =>
            typeof key !== "string" ||
            !spec.fields.some(
              (field) => field.key === key && field.kind === "secret",
            ),
        )
      )
        throw new ValidationError(["Kies alleen geheime velden om te wissen."]);
      for (const key of clearSecrets as string[]) next[key] = "";
    }
    return next;
  }

  private publicValues(id: string, values: ConnectionValues): ConnectionValues {
    const result: ConnectionValues = {};
    for (const field of connectionSpec(id).fields) {
      if (field.kind === "secret" || values[field.key] === undefined) continue;
      result[field.key] =
        field.kind === "url"
          ? displayUrl(String(values[field.key]))
          : values[field.key]!;
    }
    return result;
  }

  history(): ServiceConnectionRevision[] {
    return readConnections(this.config.dataDir)
      .history.flatMap((entry) => {
        try {
          if (
            !entry ||
            typeof entry.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(entry.id) ||
            typeof entry.at !== "string" ||
            !Number.isFinite(Date.parse(entry.at))
          )
            return [];
          const spec = connectionSpec(entry.service);
          return [
            {
              id: entry.id,
              service: spec.id,
              at: entry.at,
              before: this.publicValues(
                spec.id,
                normalizeConnection(spec.id, entry.before),
              ),
              after: this.publicValues(
                spec.id,
                normalizeConnection(spec.id, entry.after),
              ),
              secretChanges: Array.isArray(entry.secretChanges)
                ? entry.secretChanges.filter((key) =>
                    spec.fields.some(
                      (field) => field.key === key && field.kind === "secret",
                    ),
                  )
                : [],
              ...(typeof entry.revertedFrom === "string" &&
              /^[0-9a-f-]{36}$/i.test(entry.revertedFrom)
                ? { revertedFrom: entry.revertedFrom }
                : {}),
            },
          ];
        } catch {
          return [];
        }
      })
      .reverse();
  }

  save(
    id: string,
    input: unknown,
    clearSecrets?: unknown,
    revertedFrom?: string,
  ): ServiceConnection[] {
    this.auditWarning = undefined;
    const before = this.effective(id),
      next = this.candidate(id, input, clearSecrets);
    const spec = connectionSpec(id);
    const changed = spec.fields.filter(
      (field) => next[field.key] !== before[field.key],
    );
    if (!changed.length) return this.list();
    const secretChanges = changed
      .filter((field) => field.kind === "secret")
      .map((field) => field.key);
    const revision = {
      id: crypto.randomUUID(),
      service: id,
      at: new Date().toISOString(),
      before: this.publicValues(id, before),
      after: this.publicValues(id, next),
      secretChanges,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    // The audit records field names only. An audit failure prevents persisting a sensitive change.
    this.audit.record({
      sessionId: "settings",
      tool: "settings_service_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: {
        service: id,
        fields: changed.map((field) => field.key),
        secretChanges,
        ...(revertedFrom ? { revertedFrom } : {}),
      },
      phase: "attempt",
    });
    const data = readConnections(this.config.dataDir);
    // Store only submitted differences; blank replacement secrets preserve their previous value.
    const saved = { ...data.services[id] };
    for (const field of changed) saved[field.key] = next[field.key]!;
    data.services[id] = saved;
    data.history = [...data.history, revision].slice(-100);
    const file = connectionFile(this.config.dataDir),
      temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_service_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { service: id, revision: revision.id },
        result: { ok: true, restartRequired: true },
      });
    } catch {
      this.auditWarning =
        "De koppeling is opgeslagen, maar de laatste auditmelding kon niet worden geschreven. De wijziging staat wel in de lokale geschiedenis.";
    }
    return this.list();
  }

  rollback(revisionId: string): ServiceConnection[] {
    const revision = this.history().find((item) => item.id === revisionId);
    if (!revision)
      throw new ValidationError(["Deze wijziging is niet meer beschikbaar."]);
    if (revision.secretChanges.length)
      throw new ValidationError([
        "Geheime waarden staan niet in de geschiedenis. Vul de gewenste waarde opnieuw in.",
      ]);
    const current = this.effective(revision.service);
    const changes = Object.entries(revision.before).filter(
      ([key, value]) => revision.after[key] !== value,
    );
    if (changes.some(([key]) => current[key] !== revision.after[key]))
      throw new ValidationError([
        "Deze velden zijn later opnieuw gewijzigd. Bekijk de huidige waarden voordat je terugdraait.",
      ]);
    return this.save(
      revision.service,
      Object.fromEntries(changes),
      undefined,
      revision.id,
    );
  }
}
