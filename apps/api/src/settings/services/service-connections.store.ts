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
  type ConnectionValues,
} from "../../core/config/service-connections.js";

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
