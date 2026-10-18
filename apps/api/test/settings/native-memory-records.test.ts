import { describe, expect, it, vi } from "vitest";
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
  const service = new NativeMemoryRecordsService(
    { scope: "nova-owner", request } as unknown as OmniRouteManagement,
    audit,
  );
  return {
    service,
    request,
    record,
    get row() {
      return row;
    },
  };
}

describe("NOVA-owned native memory record changes (single step)", () => {
  it.each(["jarvis", "nova"])(
    "checks %s owner and deletes in one call",
    async (application) => {
      const f = fixture(application);
      expect(await f.service.delete({ id: "owned-record" })).toEqual({
        ok: true,
        verified: true,
      });
      expect(f.row).toBeNull();
      expect(f.request).toHaveBeenCalledWith("/api/memory/owned-record", {
        method: "DELETE",
      });
      expect(f.record).toHaveBeenCalled();
      expect(JSON.stringify(f.record.mock.calls)).not.toContain(
        "private memory",
      );
    },
  );

  it("bulk deletes the selected records in one call", async () => {
    const f = fixture();
    expect(await f.service.deleteMany({ ids: ["owned-record"] })).toEqual({
      ok: true,
      verified: true,
    });
    expect(f.row).toBeNull();
  });

  it("rejects bulk selections with duplicate, excessive, or unowned IDs", async () => {
    const f = fixture();
    await expect(
      f.service.deleteMany({ ids: ["owned-record", "owned-record"] }),
    ).rejects.toThrow();
    await expect(
      f.service.deleteMany({
        ids: Array.from({ length: 26 }, (_, i) => `r${i}`),
      }),
    ).rejects.toThrow();
    expect(
      await f.service.deleteMany({ ids: ["another-record"] }),
    ).toMatchObject({ ok: false });
  });

  it("refuses records owned by another key or app", async () => {
    const f = fixture();
    (f.row as Record<string, unknown>).apiKeyId = "other-owner";
    expect(await f.service.delete({ id: "owned-record" })).toMatchObject({
      ok: false,
    });
    (f.row as Record<string, unknown>).apiKeyId = "nova-owner";
    (f.row as Record<string, unknown>).metadata = { application: "other" };
    expect(await f.service.delete({ id: "owned-record" })).toMatchObject({
      ok: false,
    });
    expect(f.request).not.toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "DELETE",
    });
  });

  it("edits one record in one call without putting its text in the audit log", async () => {
    const f = fixture();
    expect(
      await f.service.update({
        id: "owned-record",
        content: "Updated private memory",
      }),
    ).toEqual({ ok: true, verified: true });
    expect(f.row?.content).toBe("Updated private memory");
    expect(f.request).toHaveBeenCalledWith("/api/memory/owned-record", {
      method: "PUT",
      body: { content: "Updated private memory" },
    });
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "Updated private memory",
    );
  });

  it("rejects unsafe content and malformed input", async () => {
    const f = fixture();
    await expect(
      f.service.update({ id: "owned-record", content: "api_key=do-not-keep" }),
    ).rejects.toThrow();
    await expect(
      f.service.update({ id: "owned-record", content: "x", extra: true }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
