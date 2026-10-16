import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type {
  NativeMemoryRecordPrepared,
  NativeMemoryRecordsDeletePrepared,
  NativeMemoryRecordResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object } from "./request-input.js";

const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = "Geheugenrecord kon niet veilig worden gecontroleerd.";

/** Deletes one explicitly selected NOVA-owned memory record after fresh approval. */
@Injectable()
export class NativeMemoryRecordsService {
  private inFlight = false;
  private clearDraft(id: string): void {
    const draft = this.drafts.get(id);
    if (draft) clearTimeout(draft.timer);
    this.drafts.delete(id);
  }
  private readonly drafts = new Map<
    string,
    {
      sessionId: string;
      content: string;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

  private async row(id: string): Promise<Record<string, unknown>> {
    const result = object(
      await this.management.request(`/api/memory/${encodeURIComponent(id)}`),
    );
    const row = Object.keys(object(result.data)).length
      ? object(result.data)
      : result;
    const metadata = object(row.metadata);
    if (
      row.id !== id ||
      row.apiKeyId !== this.management.scope ||
      (metadata.application !== "nova" && metadata.application !== "jarvis") ||
      typeof row.content !== "string"
    )
      throw new Error("Memory ownership check failed");
    return row;
  }

  async prepare(value: unknown): Promise<NativeMemoryRecordPrepared> {
    const input = object(value);
    const id = input.id;
    if (
      Object.keys(input).some((key) => key !== "id") ||
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(id)
    )
      throw new ValidationError(["Ongeldig geheugenrecord."]);
    try {
      const row = await this.row(id);
      this.audit.record({
        sessionId: "settings",
        tool: "native_memory_record_delete",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id },
      });
      const action = this.confirmations.create(
        `settings-memory-record:${crypto.randomUUID()}`,
        "native_memory_record_delete",
        { id, revision: digest(row) },
        "DANGEROUS",
        undefined,
        false,
      );
      return { ok: true, action };
    } catch {
      return { ok: false, error: unavailable };
    }
  }

  async prepareDeleteMany(
    value: unknown,
  ): Promise<NativeMemoryRecordsDeletePrepared> {
    const input = object(value);
    const ids = input.ids;
    if (
      Object.keys(input).some((key) => key !== "ids") ||
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 25 ||
      ids.some(
        (id) => typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(id),
      ) ||
      new Set(ids).size !== ids.length
    )
      throw new ValidationError(["Selecteer één tot 25 geldige records."]);
    try {
      const rows = await Promise.all(ids.map((id) => this.row(id)));
      const records = rows.map((row, index) => ({
        id: ids[index] as string,
        revision: digest(row),
      }));
      this.audit.record({
        sessionId: "settings",
        tool: "native_memory_records_delete",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { count: records.length },
      });
      const action = this.confirmations.create(
        `settings-memory-record:${crypto.randomUUID()}`,
        "native_memory_records_delete",
        { records },
        "DANGEROUS",
        undefined,
        false,
      );
      return { ok: true, action, count: records.length };
    } catch {
      return { ok: false, error: unavailable };
    }
  }

  async prepareUpdate(value: unknown): Promise<NativeMemoryRecordPrepared> {
    const input = object(value);
    const { id, content } = input;
    if (
      Object.keys(input).some((key) => !["id", "content"].includes(key)) ||
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(id) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 4000 ||
      String(sanitize(content)) !== content
    )
      throw new ValidationError([
        "Ongeldig geheugenrecord of inhoud met mogelijk geheime gegevens.",
      ]);
    for (const [key, draft] of this.drafts)
      if (
        draft.expiresAt <= this.confirmations.now() ||
        !this.confirmations.has(draft.sessionId)
      )
        this.clearDraft(key);
    if (this.drafts.size >= 20)
      return { ok: false, error: "Te veel openstaande geheugenwijzigingen." };
    try {
      const row = await this.row(id);
      this.audit.record({
        sessionId: "settings",
        tool: "native_memory_record_update",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id },
      });
      const action = this.confirmations.create(
        `settings-memory-record:${crypto.randomUUID()}`,
        "native_memory_record_update",
        { id, revision: digest(row) },
        "DANGEROUS",
        undefined,
        false,
      );
      const draft = {
        sessionId: action.sessionId,
        content,
        expiresAt: action.expiresAt,
        timer: setTimeout(
          () => this.clearDraft(action.confirmationId),
          Math.max(0, action.expiresAt - this.confirmations.now()),
        ),
      };
      draft.timer.unref?.();
      this.drafts.set(action.confirmationId, draft);
      return { ok: true, action };
    } catch {
      return { ok: false, error: unavailable };
    }
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<NativeMemoryRecordResult> {
    if (
      !/^settings-memory-record:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      ![
        "native_memory_record_delete",
        "native_memory_record_update",
        "native_memory_records_delete",
      ].includes(pending?.tool ?? "") ||
      pending.confirmationId !== confirmationId
    ) {
      this.clearDraft(confirmationId);
      return {
        ok: false,
        error: "Bevestiging verlopen. Laad records opnieuw.",
      };
    }
    if (!approve) {
      this.clearDraft(confirmationId);
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action) {
      this.clearDraft(confirmationId);
      return { ok: false, error: "Bevestiging verlopen." };
    }
    const updateDraft = this.drafts.get(confirmationId);
    this.clearDraft(confirmationId);
    const updating = action.tool === "native_memory_record_update";
    const deletingMany = action.tool === "native_memory_records_delete";
    if (
      action.tool !== "native_memory_record_delete" &&
      action.tool !== "native_memory_record_update" &&
      !deletingMany
    )
      return { ok: false, error: "Actie ongeldig. Laad records opnieuw." };
    if (
      updating &&
      (!updateDraft ||
        updateDraft.sessionId !== sessionId ||
        updateDraft.expiresAt <= this.confirmations.now())
    )
      return {
        ok: false,
        error: "Concept verlopen. Bereid de wijziging opnieuw voor.",
      };
    if (this.inFlight)
      return { ok: false, error: "Een geheugenwijziging is al bezig." };
    if (deletingMany) {
      const records = action.args.records;
      if (
        !Array.isArray(records) ||
        records.length < 1 ||
        records.length > 25 ||
        records.some((raw) => {
          const record = object(raw);
          return (
            Object.keys(record).some(
              (key) => !["id", "revision"].includes(key),
            ) ||
            typeof record.id !== "string" ||
            !/^[a-zA-Z0-9_.-]{1,100}$/.test(record.id) ||
            typeof record.revision !== "string"
          );
        })
      )
        return { ok: false, error: "Selectie ongeldig. Laad records opnieuw." };
      const recordsTyped = records as Array<{ id: string; revision: string }>;
      if (
        new Set(recordsTyped.map((record) => record.id)).size !==
        recordsTyped.length
      )
        return { ok: false, error: "Selectie ongeldig. Laad records opnieuw." };
      this.inFlight = true;
      try {
        const current = await Promise.all(
          recordsTyped.map(async (record) => ({
            record,
            row: await this.row(record.id).catch(() => null),
          })),
        );
        if (
          current.some(
            ({ record, row }) => !row || digest(row) !== record.revision,
          )
        )
          return {
            ok: false,
            error: "Een record is gewijzigd. Laad records opnieuw.",
          };
        for (const { record } of current) {
          this.audit.record({
            sessionId,
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: { id: record.id },
          });
        }
        let deleted = 0;
        for (const { record } of current) {
          try {
            await this.management.request(
              `/api/memory/${encodeURIComponent(record.id)}`,
              {
                method: "DELETE",
              },
            );
            try {
              await this.row(record.id);
              this.audit.record({
                sessionId,
                tool: action.tool,
                risk: "DANGEROUS",
                confirmation: "confirmed_admin_ui",
                phase: "after_execute",
                arguments: { id: record.id },
                result: { ok: false },
                verification: { persisted: false },
              });
              return {
                ok: false,
                verified: null,
                error:
                  "Bulkverwijdering gedeeltelijk uitgevoerd. Vernieuw de lijst.",
              };
            } catch (error) {
              if (!(error instanceof Error) || !/\(404\)/.test(error.message))
                return {
                  ok: false,
                  verified: null,
                  error: "Bulkverwijdering onzeker. Vernieuw de lijst.",
                };
            }
            deleted++;
            this.audit.record({
              sessionId,
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: { id: record.id },
              result: { ok: true },
              verification: { persisted: true },
            });
          } catch {
            return {
              ok: false,
              verified: null,
              error: deleted
                ? "Bulkverwijdering gedeeltelijk uitgevoerd. Vernieuw de lijst."
                : "Bulkverwijdering onzeker. Vernieuw de lijst.",
            };
          }
        }
        return { ok: true, verified: true };
      } catch {
        return {
          ok: false,
          verified: null,
          error: "Bulkverwijdering onzeker. Vernieuw de lijst.",
        };
      } finally {
        this.inFlight = false;
      }
    }
    const id = action.args.id;
    const revision = action.args.revision;
    if (
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(id) ||
      typeof revision !== "string"
    )
      return {
        ok: false,
        error: "Bevestiging ongeldig. Laad records opnieuw.",
      };
    this.inFlight = true;
    try {
      const current = await this.row(id).catch(() => null);
      if (!current || digest(current) !== revision)
        return {
          ok: false,
          error: "Record is gewijzigd. Laad records opnieuw.",
        };
      try {
        this.audit.record({
          sessionId,
          tool: action.tool,
          risk: "DANGEROUS",
          confirmation: "confirmed_admin_ui",
          phase: "before_execute",
          arguments: { id },
        });
      } catch {
        return {
          ok: false,
          error: "Wijziging geblokkeerd: actielog niet beschikbaar.",
        };
      }
      const endpoint = `/api/memory/${encodeURIComponent(id)}`;
      if (updating) {
        await this.management.request(endpoint, {
          method: "PUT",
          body: { content: updateDraft!.content },
        });
        const after = await this.row(id);
        if (after.content !== updateDraft!.content)
          return {
            ok: false,
            verified: false,
            error: "Wijziging kon niet worden gecontroleerd.",
          };
      } else {
        await this.management.request(endpoint, { method: "DELETE" });
        try {
          await this.row(id);
          return {
            ok: false,
            verified: false,
            error: "Verwijdering kon niet worden gecontroleerd.",
          };
        } catch (error) {
          if (!(error instanceof Error) || !/\(404\)/.test(error.message))
            return {
              ok: false,
              verified: null,
              error: "Verwijdering onzeker. Laad de records opnieuw.",
            };
        }
      }
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        phase: "after_execute",
        arguments: { id },
        result: { ok: true },
        verification: { persisted: true },
      });
      return { ok: true, verified: true };
    } catch {
      return {
        ok: false,
        verified: null,
        error: "Geheugenwijziging onzeker. Laad de records opnieuw.",
      };
    } finally {
      this.inFlight = false;
    }
  }
}
