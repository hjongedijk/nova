import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const service = new NativeMemorySettingsService(
    { dataFile: (name: string) => path.join(dir, name) } as NovaConfig,
    { request } as unknown as OmniRouteManagement,
    audit,
  );
  return {
    service,
    request,
    record,
    get: () => settings,
    historyFile,
  };
}

describe("NOVA-owned OmniRoute memory switch (single step)", () => {
  it("projects settings without secrets and rejects malformed input", async () => {
    const f = fixture();
    expect(await f.service.status()).toEqual({
      enabled: false,
      backend: "sqlite",
      maxTokens: 1200,
    });
    await expect(f.service.apply({})).rejects.toThrow();
    await expect(
      f.service.apply({ enabled: true, acknowledgeGlobal: true }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "never-return-this",
    );
  });

  it("updates only the global enabled flag in one call", async () => {
    const f = fixture();
    expect(await f.service.apply({ enabled: true })).toMatchObject({
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
    expect(f.record).toHaveBeenCalled();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      "never-return-this",
    );
  });

  it("reports an unchanged switch without writing", async () => {
    const f = fixture();
    expect(await f.service.apply({ enabled: false })).toMatchObject({
      ok: false,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("restores a prior global switch in one call from its history revision", async () => {
    const f = fixture();
    await f.service.apply({ enabled: true });
    const revision = f.service.history().revisions[0]!;
    expect(await f.service.rollback(revision.id)).toMatchObject({
      ok: true,
      enabled: false,
      verified: true,
    });
    expect(f.service.history().revisions[0]).toMatchObject({
      before: true,
      after: false,
      revertedFrom: revision.id,
    });
    await expect(f.service.rollback("nope")).rejects.toThrow();
  });
});
