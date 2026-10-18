import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativePromptController } from "../../src/settings/native-prompt.controller.js";
import { NativePromptService } from "../../src/settings/native-prompt.service.js";

type Prompt = { enabled: boolean; prefixPrompt: string; suffixPrompt: string };
const replacement: Prompt = {
  enabled: true,
  prefixPrompt: "Nieuwe regels 🌻",
  suffixPrompt: "Nieuw slot",
};
const input = (prompt = replacement) => ({ ...prompt });
const oldPrompt = {
  enabled: false,
  prefixPrompt: "Bearer old-prefix-secret",
  suffixPrompt: "password=old-suffix-secret",
  extra: "obsolete",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture(initial: string | undefined = JSON.stringify(oldPrompt)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-native-prompt-"));
  const database = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(database);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE key_value(namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key))",
  );
  const store = (value: string | undefined) => {
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM key_value WHERE namespace='settings' AND key='systemPrompt'",
      ).run();
      if (value !== undefined)
        db.prepare(
          "INSERT INTO key_value VALUES ('settings','systemPrompt',?)",
        ).run(value);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  store(initial);
  const read = () =>
    (
      db
        .prepare(
          "SELECT value FROM key_value WHERE namespace='settings' AND key='systemPrompt'",
        )
        .get() as { value: string } | undefined
    )?.value;
  const config = {
    omniUrl: "http://fixture.invalid/v1",
    verifiedOmniUrl: "http://fixture.invalid/v1",
    omniDatabase: database,
    dataFile: (name: string) => path.join(dir, name),
  };
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const configured = vi.fn(() => true);
  let runtime: Prompt | undefined;
  const request = vi.fn(
    async (_endpoint: string, options?: { method: string; body: Prompt }) => {
      if (options) {
        store(JSON.stringify(options.body));
        runtime = structuredClone(options.body);
      }
      return runtime;
    },
  );
  const management = {
    get configured() {
      return configured();
    },
    request,
  };
  const service = new NativePromptService(
    config as NovaConfig,
    management as unknown as OmniRouteManagement,
    audit,
  );
  const apply = (prompt = replacement) => service.replace(input(prompt));
  return {
    db,
    config,
    record,
    configured,
    request,
    service,
    store,
    read,
    apply,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("native prompt replacement (single step)", () => {
  it.each([true, false])(
    "replaces all three fields in one call and verifies SQLite plus runtime with enabled=%s",
    async (enabled) => {
      const f = fixture();
      const prompt = { ...replacement, enabled, suffixPrompt: "" };
      expect(await f.apply(prompt)).toEqual({ ok: true, verified: true });
      expect(JSON.parse(f.read()!)).toEqual(prompt);
      expect(f.request.mock.calls).toEqual([
        ["/api/settings/system-prompt", { method: "PUT", body: prompt }],
        ["/api/settings/system-prompt"],
      ]);
      expect(f.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phase: "after_execute",
          verification: { persisted: true, runtime: true },
        }),
      );
      const audit = JSON.stringify(f.record.mock.calls);
      for (const text of [
        prompt.prefixPrompt,
        oldPrompt.prefixPrompt,
        oldPrompt.suffixPrompt,
      ])
        expect(audit).not.toContain(text);
    },
  );

  it("stores only new secret-free prompt revisions with private file permissions", async () => {
    const f = fixture(
      JSON.stringify({
        enabled: false,
        prefixPrompt: "Bearer legacy-secret",
        suffixPrompt: "",
      }),
    );
    expect((await f.apply()).verified).toBe(true);
    expect(f.service.history().revisions).toEqual([]);
    const nextPrompt = { ...replacement, prefixPrompt: "Clean next version" };
    expect((await f.apply(nextPrompt)).verified).toBe(true);
    const history = f.service.history();
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({
      before: replacement,
      after: nextPrompt,
    });
    expect(
      fs.statSync(
        path.join(
          path.dirname(f.config.omniDatabase),
          "native-prompt-history.json",
        ),
      ).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(history)).not.toContain("legacy-secret");
  });

  it("limits imported history entries to the newest twenty", () => {
    const f = fixture();
    const file = path.join(
      path.dirname(f.config.omniDatabase),
      "native-prompt-history.json",
    );
    const entries = Array.from({ length: 25 }, (_, index) => ({
      id: crypto.randomUUID(),
      at: new Date(1000 + index).toISOString(),
      before: {
        enabled: false,
        prefixPrompt: `before ${index}`,
        suffixPrompt: "",
      },
      after: {
        enabled: true,
        prefixPrompt: `after ${index}`,
        suffixPrompt: "",
      },
    }));
    fs.writeFileSync(file, JSON.stringify(entries));
    const history = f.service.history();
    expect(history.revisions).toHaveLength(20);
    expect(history.revisions[0]!.after.prefixPrompt).toBe("after 24");
    expect(history.truncated).toBe(true);
  });

  it("supports a missing row", async () => {
    const f = fixture();
    f.store(undefined);
    expect(await f.apply()).toEqual({ ok: true, verified: true });
    expect(JSON.parse(f.read()!)).toEqual(replacement);
  });

  it("serialises overlapping replacements and releases the guard after a failure", async () => {
    const f = fixture();
    const persist = f.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async () => {
      await gate;
      throw new Error("fixture failure");
    });
    const pending = f.apply();
    expect(await f.apply({ ...replacement, enabled: false })).toMatchObject({
      ok: false,
      error: expect.stringContaining("al gewijzigd"),
    });
    release();
    expect(await pending).toMatchObject({ ok: false, verified: null });
    f.request.mockImplementation(persist);
    expect(await f.apply()).toEqual({ ok: true, verified: true });
  });

  it("blocks writes when before_execute auditing fails", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "before_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.apply()).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.read()).toBe(JSON.stringify(oldPrompt));
  });

  it("reports saved and verified state honestly if final auditing fails", async () => {
    const f = fixture();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "after_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.apply()).toMatchObject({
      ok: true,
      verified: true,
      auditWarning: expect.any(String),
    });
    expect(JSON.parse(f.read()!)).toEqual(replacement);
  });

  it.each([
    "echo",
    "database",
    "extra-field",
    "malformed",
    "runtime-mismatch",
    "runtime-error",
  ])("cannot verify %s failures", async (failure) => {
    const f = fixture();
    const persist = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (endpoint, options) => {
      if (options) {
        if (failure === "echo") return options.body;
        await persist(endpoint, options);
        if (failure === "database")
          f.config.omniDatabase = path.join(
            path.dirname(f.config.omniDatabase),
            "missing.sqlite",
          );
        if (failure === "extra-field")
          f.store(JSON.stringify({ ...options.body, extra: true }));
        if (failure === "malformed") f.store("{broken");
        return options.body;
      }
      if (failure === "runtime-error")
        throw new Error("fixture runtime failure");
      return { ...replacement, suffixPrompt: "runtime mismatch" };
    });
    expect(await f.apply()).toMatchObject({
      ok: false,
      verified: null,
      error: expect.stringContaining("kan al gewijzigd zijn"),
    });
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: { ok: false },
        verification: { persisted: null, runtime: null },
      }),
    );
  });

  it.each(["provenance", "configured", "database"])(
    "fails closed before writes for unavailable %s",
    async (failure) => {
      const f = fixture();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "configured") f.configured.mockReturnValue(false);
      if (failure === "database") f.config.omniDatabase += ".missing";
      expect(await f.apply()).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});

describe("native prompt validation and API guards", () => {
  it.each([
    null,
    [],
    {},
    { ...input(), enabled: 1 },
    { ...input(), prefixPrompt: null },
    { ...input(), suffixPrompt: 4 },
    { ...input(), always: true },
    { ...input(), acknowledgeGlobal: true },
  ])("rejects invalid full replacements %j", async (value) => {
    const f = fixture();
    await expect(f.service.replace(value)).rejects.toThrow(ValidationError);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["prefixPrompt", "suffixPrompt"] as const)(
    "enforces 50,000 UTF-16 character bounds for %s including Unicode",
    async (key) => {
      const f = fixture();
      expect(
        (await f.apply({ ...replacement, [key]: "🌻".repeat(25000) })).ok,
      ).toBe(true);
      await expect(
        f.apply({ ...replacement, [key]: "🌻".repeat(25000) + "x" }),
      ).rejects.toThrow(ValidationError);
      await expect(
        f.apply({ ...replacement, [key]: "x".repeat(50001) }),
      ).rejects.toThrow(ValidationError);
    },
  );

  it.each([
    "Bearer new-secret",
    "sk-abcdefghijklmno",
    "password=new-secret",
    "PVEAPIToken=fixture-secret",
    "eyJabcdefghijklmnop.abcdefghijklmnop",
    "environment-private-value",
  ])(
    "rejects sanitizer-recognized proposed secrets in both fields: %s",
    async (secret) => {
      vi.stubEnv("NOVA_FIXTURE_SECRET", "environment-private-value");
      const f = fixture();
      for (const key of ["prefixPrompt", "suffixPrompt"])
        await expect(
          f.apply({ ...replacement, [key]: secret }),
        ).rejects.toThrow(ValidationError);
      expect(f.record).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("delegates the controller route straight to the service", () => {
    const service = { replace: vi.fn(() => ({ ok: true })) };
    const controller = new NativePromptController(
      service as unknown as NativePromptService,
    );
    expect(controller.replace(input())).toEqual({ ok: true });
    expect(service.replace).toHaveBeenCalledWith(input());
  });
});
