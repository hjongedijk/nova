import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativeMemoryRecordsService } from "../../src/settings/native-memory-records.service.js";

function fixture(application = "jarvis") {
  let row: Record<string, unknown> | null = {
    id: "owned-record",
    apiKeyId: "nova-owner",
    content: "private memory",
    metadata: { application },
  };
  const request = vi.fn(
    async (endpoint: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === "DELETE") {
        row = null;
        return {};
      }
      if (options?.method === "PUT" && row) {
        row.content = (options.body as { content: string }).content;
        return {};
      }
      if (!row) throw new Error("OmniRoute management request failed (404)");
      return structuredClone(row);
    },
  );
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "audit",
    timestamp: "now",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  const service = new NativeMemoryRecordsService(
    { scope: "nova-owner", request } as unknown as OmniRouteManagement,
    confirmations,
    audit,
  );
  return {
    service,
    confirmations,
    request,
    record,
    get row() {
      return row;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("NOVA-owned native memory record deletion", () => {
  it.each(["jarvis", "nova"])(
    "checks %s owner and requires fresh delete approval",
    async (application) => {
      const f = fixture(application);
      const prepared = await f.service.prepare({ id: "owned-record" });
      expect(prepared.action?.risk).toBe("DANGEROUS");
      expect(f.row).not.toBeNull();
      expect(
        await f.service.confirm(
          prepared.action!.sessionId,
          prepared.action!.confirmationId,
          true,
        ),
      ).toEqual({ ok: true, verified: true });
      expect(f.row).toBeNull();
    },
  );

  it("bulk deletes only selected unchanged records after one confirmation", async () => {
    const f = fixture();
    const prepared = await f.service.prepareDeleteMany({
      ids: ["owned-record"],
    });
    expect(prepared).toMatchObject({ ok: true, count: 1 });
    expect(prepared.action?.risk).toBe("DANGEROUS");
    expect(f.row).not.toBeNull();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("private memory");
    expect(
      await f.service.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toEqual({ ok: true, verified: true });
    expect(f.row).toBeNull();
    expect(f.request).toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "DELETE",
    });
  });

  it("rejects bulk selections with duplicate, excessive, or unowned IDs", async () => {
    const f = fixture();
    await expect(
      f.service.prepareDeleteMany({ ids: ["owned-record", "owned-record"] }),
    ).rejects.toThrow();
    await expect(
      f.service.prepareDeleteMany({
        ids: Array.from({ length: 26 }, (_, i) => `r${i}`),
      }),
    ).rejects.toThrow();
    expect(
      await f.service.prepareDeleteMany({ ids: ["another-record"] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("requires fresh confirmation, checks owner and revision, then verifies deletion", async () => {
    const f = fixture();
    const prepared = await f.service.prepare({ id: "owned-record" });
    expect(prepared.action?.risk).toBe("DANGEROUS");
    expect(f.row).not.toBeNull();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("private memory");
    const result = await f.service.confirm(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      true,
    );
    expect(result).toEqual({ ok: true, verified: true });
    expect(f.row).toBeNull();
    expect(f.request).toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "DELETE",
    });
  });

  it("refuses records owned by another key or app", async () => {
    const f = fixture();
    (f.row as Record<string, unknown>).apiKeyId = "other-owner";
    expect(await f.service.prepare({ id: "owned-record" })).toMatchObject({
      ok: false,
    });
    expect(f.request).not.toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "DELETE",
    });
    (f.row as Record<string, unknown>).apiKeyId = "nova-owner";
    (f.row as Record<string, unknown>).metadata = { application: "other" };
    expect(await f.service.prepare({ id: "owned-record" })).toMatchObject({
      ok: false,
    });
  });

  it("refuses a changed record and cancellation never deletes", async () => {
    const f = fixture();
    const prepared = await f.service.prepare({ id: "owned-record" });
    (f.row as Record<string, unknown>).content = "changed";
    expect(
      await f.service.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.row).not.toBeNull();
    const again = await f.service.prepare({ id: "owned-record" });
    expect(
      await f.service.confirm(
        again.action!.sessionId,
        again.action!.confirmationId,
        false,
      ),
    ).toEqual({ ok: true });
    expect(f.row).not.toBeNull();
  });

  it("edits one record after confirmation without putting its text in audit or action args", async () => {
    const f = fixture();
    const prepared = await f.service.prepareUpdate({
      id: "owned-record",
      content: "Updated private memory",
    });
    expect(prepared.action?.risk).toBe("DANGEROUS");
    expect(prepared.action?.args).not.toHaveProperty("content");
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "Updated private memory",
    );
    expect(
      await f.service.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toEqual({ ok: true, verified: true });
    expect(f.row?.content).toBe("Updated private memory");
    expect(f.request).toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "PUT",
      body: { content: "Updated private memory" },
    });
  });

  it("rejects unsafe content and refuses edits after a concurrent row change", async () => {
    const f = fixture();
    await expect(
      f.service.prepareUpdate({
        id: "owned-record",
        content: "api_key=do-not-keep-this",
      }),
    ).rejects.toThrow();
    const prepared = await f.service.prepareUpdate({
      id: "owned-record",
      content: "Updated memory",
    });
    (f.row as Record<string, unknown>).content = "changed elsewhere";
    expect(
      await f.service.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "PUT",
      body: { content: "Updated memory" },
    });
  });

  it("clears unconfirmed proposed text when the 60-second approval expires", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const prepared = await f.service.prepareUpdate({
      id: "owned-record",
      content: "Temporary approved memory",
    });
    const drafts = (f.service as unknown as { drafts: Map<string, unknown> })
      .drafts;
    expect(drafts.size).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drafts.size).toBe(0);
    expect(f.request).not.toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "PUT",
      body: { content: "Temporary approved memory" },
    });
    expect(prepared.action?.risk).toBe("DANGEROUS");
  });
});
