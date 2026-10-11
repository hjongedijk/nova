import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativeMemorySettingsService } from "../../src/settings/native-memory-settings.service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-native-memory-"));
  const historyFile = path.join(dir, "native-memory-settings-history.json");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings: Record<string, unknown> = {
    enabled: false,
    primaryBackend: "sqlite",
    maxTokens: 1200,
    secretMarker: "never-return-this",
  };
  const request = vi.fn(
    async (_path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === "PUT")
        settings = { ...settings, ...(options.body as object) };
      return structuredClone(settings);
    },
  );
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  const service = new NativeMemorySettingsService(
    { dataFile: (name: string) => path.join(dir, name) } as NovaConfig,
    { request } as unknown as OmniRouteManagement,
    confirmations,
    audit,
  );
  const prepare = async (enabled: boolean) => {
    const result = await service.prepare({ enabled, acknowledgeGlobal: true });
    if (!result.action) throw new Error("Missing confirmation");
    return result;
  };
  const confirm = (
    prepared: Awaited<ReturnType<typeof prepare>>,
    approve = true,
  ) =>
    service.confirm(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      approve,
    );
  return {
    service,
    request,
    record,
    confirmations,
    prepare,
    confirm,
    get: () => settings,
    historyFile,
  };
}

describe("NOVA-owned OmniRoute memory switch", () => {
  it("projects settings without secrets and requires a client-wide acknowledgement", async () => {
    const f = fixture();
    expect(await f.service.status()).toEqual({
      enabled: false,
      backend: "sqlite",
      maxTokens: 1200,
    });
    await expect(f.service.prepare({ enabled: true })).rejects.toThrow();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "never-return-this",
    );
  });

  it("updates only the global enabled flag after fresh DANGEROUS consent", async () => {
    const f = fixture();
    const prepared = await f.prepare(true);
    expect(prepared.action!.risk).toBe("DANGEROUS");
    expect(await f.confirm(prepared)).toMatchObject({
      ok: true,
      verified: true,
      enabled: true,
    });
    expect(f.request).toHaveBeenCalledWith("/api/settings/memory", {
      method: "PUT",
      body: { enabled: true },
    });
    expect(f.get()).toMatchObject({
      primaryBackend: "sqlite",
      maxTokens: 1200,
    });
    expect(f.service.history().revisions).toMatchObject([
      { before: false, after: true },
    ]);
    expect(fs.statSync(f.historyFile).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "never-return-this",
    );
  });

  it("refuses a stale settings snapshot and supports cancellation", async () => {
    const f = fixture();
    const stale = await f.prepare(true);
    f.get().primaryBackend = "qdrant";
    expect(await f.confirm(stale)).toMatchObject({ ok: false });
    expect(f.request).toHaveBeenCalledTimes(2);
    const cancelled = await f.prepare(true);
    expect(await f.confirm(cancelled, false)).toEqual({ ok: true });
  });

  it("restores a prior global switch only from its current history revision", async () => {
    const f = fixture();
    const first = await f.prepare(true);
    await f.confirm(first);
    const revision = f.service.history().revisions[0]!;
    const prepared = await f.service.prepareRollback(revision.id, true);
    expect(prepared).toMatchObject({ ok: true, enabled: false });
    expect(prepared.action!.risk).toBe("DANGEROUS");
    expect(
      await f.service.confirm(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: true, enabled: false, verified: true });
    expect(f.service.history().revisions[0]).toMatchObject({
      before: true,
      after: false,
      revertedFrom: revision.id,
    });
  });
});
