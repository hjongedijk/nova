import { Injectable } from "@nestjs/common";
import type { NativeMemoryRecordResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object } from "./request-input.js";

const idPattern = /^[a-zA-Z0-9_.-]{1,100}$/;

/** Deletes or updates explicitly selected NOVA-owned memory records directly. */
@Injectable()
export class NativeMemoryRecordsService {
  private inFlight = false;
  constructor(
    private readonly management: OmniRouteManagement,
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

  private record(
    tool: string,
    phase: "before_execute" | "after_execute",
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    this.audit.record({
      sessionId: "settings",
      tool,
      risk: "DANGEROUS",
      confirmation: "direct",
      phase,
      arguments: args,
      ...extra,
    });
  }

  /** Deletes one memory record. */
  async delete(value: unknown): Promise<NativeMemoryRecordResult> {
    const input = object(value);
    const id = input.id;
    if (
      Object.keys(input).some((key) => key !== "id") ||
      typeof id !== "string" ||
      !idPattern.test(id)
    )
      throw new ValidationError(["Ongeldig geheugenrecord."]);
    return this.run("native_memory_record_delete", async () => {
      await this.row(id);
      this.record("native_memory_record_delete", "before_execute", { id });
      await this.management.request(`/api/memory/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
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
      this.record(
        "native_memory_record_delete",
        "after_execute",
        { id },
        { result: { ok: true }, verification: { persisted: true } },
      );
      return { ok: true, verified: true };
    });
  }

  /** Deletes several selected memory records. */
  async deleteMany(value: unknown): Promise<NativeMemoryRecordResult> {
    const input = object(value);
    const ids = input.ids;
    if (
      Object.keys(input).some((key) => key !== "ids") ||
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 25 ||
      ids.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new ValidationError(["Selecteer één tot 25 geldige records."]);
    const tool = "native_memory_records_delete";
    return this.run(
      tool,
      async () => {
        await Promise.all((ids as string[]).map((id) => this.row(id)));
        let deleted = 0;
        for (const id of ids as string[]) {
          this.record(tool, "before_execute", { id });
          try {
            await this.management.request(
              `/api/memory/${encodeURIComponent(id)}`,
              { method: "DELETE" },
            );
            try {
              await this.row(id);
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
            this.record(
              tool,
              "after_execute",
              { id },
              { result: { ok: true }, verification: { persisted: true } },
            );
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
      },
      "Bulkverwijdering onzeker. Vernieuw de lijst.",
    );
  }

  /** Replaces the content of one memory record. */
  async update(value: unknown): Promise<NativeMemoryRecordResult> {
    const input = object(value);
    const { id, content } = input;
    if (
      Object.keys(input).some((key) => !["id", "content"].includes(key)) ||
      typeof id !== "string" ||
      !idPattern.test(id) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 4000 ||
      String(sanitize(content)) !== content
    )
      throw new ValidationError([
        "Ongeldig geheugenrecord of inhoud met mogelijk geheime gegevens.",
      ]);
    const tool = "native_memory_record_update";
    return this.run(
      tool,
      async () => {
        await this.row(id);
        this.record(tool, "before_execute", { id });
        await this.management.request(`/api/memory/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: { content },
        });
        const after = await this.row(id);
        if (after.content !== content)
          return {
            ok: false,
            verified: false,
            error: "Wijziging kon niet worden gecontroleerd.",
          };
        this.record(
          tool,
          "after_execute",
          { id },
          { result: { ok: true }, verification: { persisted: true } },
        );
        return { ok: true, verified: true };
      },
      "Geheugenwijziging onzeker. Laad de records opnieuw.",
    );
  }

  private async run(
    _tool: string,
    action: () => Promise<NativeMemoryRecordResult>,
    failure = "Geheugenrecord kon niet veilig worden gecontroleerd.",
  ): Promise<NativeMemoryRecordResult> {
    if (this.inFlight)
      return { ok: false, error: "Een geheugenwijziging is al bezig." };
    this.inFlight = true;
    try {
      return await action();
    } catch {
      return { ok: false, verified: null, error: failure };
    } finally {
      this.inFlight = false;
    }
  }
}
