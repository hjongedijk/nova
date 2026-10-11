import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativePromptController } from "../../src/settings/native-prompt.controller.js";
import { NativePromptService } from "../../src/settings/native-prompt.service.js";
import { ADMIN, createApp } from "./helpers.js";

type Prompt = { enabled: boolean; prefixPrompt: string; suffixPrompt: string };
const replacement: Prompt = {
  enabled: true,
  prefixPrompt: "Nieuwe regels 🌻",
  suffixPrompt: "Nieuw slot",
};
const input = (prompt = replacement) => ({
  ...prompt,
  acknowledgeGlobal: true,
});
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
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => now;
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
    confirmations,
    audit,
  );
  cleanups.push(() => service.onModuleDestroy());
  const prepare = (prompt = replacement) => {
    const result = service.prepare(input(prompt));
    expect(result.ok).toBe(true);
    if (!result.action) throw new Error("Missing fixture confirmation");
    return result.action;
  };
  const approve = (action: ReturnType<typeof prepare>, approved = true) =>
    service.confirm(action.sessionId, action.confirmationId, approved);
  return {
    db,
    config,
    record,
    confirmations,
    configured,
    request,
    service,
    store,
    read,
    prepare,
    approve,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("native prompt replacement", () => {
  it("prepares private drafts with metadata-only approvals, no writes and 60-second session binding", async () => {
    const f = fixture();
    const before = f.read();
    const first = f.prepare();
    const second = f.prepare();
    expect(first).toMatchObject({
      tool: "native_prompt_replace",
      risk: "DANGEROUS",
      allowAlways: false,
      createdAt: 1000,
      expiresAt: 61000,
      args: {
        enabled: true,
        prefixCharacters: replacement.prefixPrompt.length,
        suffixCharacters: replacement.suffixPrompt.length,
      },
    });
    expect(first.sessionId).toMatch(/^settings-prompt:[0-9a-f-]{36}$/);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.confirmationId).not.toBe(second.confirmationId);
    expect(f.read()).toBe(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      await f.service.confirm(second.sessionId, first.confirmationId, true),
    ).toMatchObject({ ok: false });
    expect(
      await f.service.confirm(
        `settings-prompt:${crypto.randomUUID()}`,
        first.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false });
    expect(f.confirmations.has(first.sessionId)).toBe(true);
    const exposed = JSON.stringify([
      first,
      second,
      f.confirmations.peek(first.sessionId),
      f.record.mock.calls,
    ]);
    for (const text of [
      replacement.prefixPrompt,
      replacement.suffixPrompt,
      oldPrompt.prefixPrompt,
      oldPrompt.suffixPrompt,
    ])
      expect(exposed).not.toContain(text);
  });

  it.each([true, false])(
    "replaces all three fields and verifies SQLite plus runtime with enabled=%s",
    async (enabled) => {
      const f = fixture();
      const prompt = { ...replacement, enabled, suffixPrompt: "" };
      const action = f.prepare(prompt);
      // Returned arguments cannot edit the private replacement.
      action.args.prefixPrompt = "mutated approval";
      expect(await f.approve(action)).toEqual({ ok: true, verified: true });
      expect(JSON.parse(f.read()!)).toEqual(prompt);
      expect(f.request.mock.calls).toEqual([
        ["/api/settings/system-prompt", { method: "PUT", body: prompt }],
        ["/api/settings/system-prompt"],
      ]);
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request).toHaveBeenCalledTimes(2);
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
    const first = f.prepare();
    expect((await f.approve(first)).verified).toBe(true);
    expect(f.service.history().revisions).toEqual([]);
    const nextPrompt = { ...replacement, prefixPrompt: "Clean next version" };
    const second = f.prepare(nextPrompt);
    expect((await f.approve(second)).verified).toBe(true);
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

  it("cancels once without writes or exposing old or proposed prompt contents", async () => {
    const f = fixture();
    const action = f.prepare();
    expect(await f.approve(action, false)).toEqual({ ok: true });
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.read()).toBe(JSON.stringify(oldPrompt));
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        confirmation: "rejected_admin_ui",
        arguments: action.args,
      }),
    );
    const exposed = JSON.stringify(f.record.mock.calls);
    for (const text of [
      replacement.prefixPrompt,
      replacement.suffixPrompt,
      oldPrompt.prefixPrompt,
      oldPrompt.suffixPrompt,
    ])
      expect(exposed).not.toContain(text);
  });

  it.each([59999, 60000, 60001])(
    "expires exactly at 60 seconds (%i ms)",
    async (elapsed) => {
      const f = fixture();
      const action = f.prepare();
      f.advance(elapsed);
      expect((await f.approve(action)).ok).toBe(elapsed < 60000);
      expect(f.request).toHaveBeenCalledTimes(elapsed < 60000 ? 2 : 0);
      expect(f.confirmations.has(action.sessionId)).toBe(false);
    },
  );

  it.each([
    "changed",
    "removed",
    "missing-added",
    "missing-null",
    "same-content-different-bytes",
  ])("rejects changed row hashes: %s", async (change) => {
    const f = fixture();
    if (change.startsWith("missing")) f.store(undefined);
    const action = f.prepare();
    f.store(
      change === "removed"
        ? undefined
        : change === "missing-null"
          ? "null"
          : change === "same-content-different-bytes"
            ? JSON.stringify(oldPrompt, null, 2)
            : JSON.stringify(replacement),
    );
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.confirmations.has(action.sessionId)).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("supports a missing row when its missing marker remains unchanged", async () => {
    const f = fixture();
    f.store(undefined);
    expect(await f.approve(f.prepare())).toEqual({ ok: true, verified: true });
    expect(JSON.parse(f.read()!)).toEqual(replacement);
  });

  it.each([false, true])(
    "consumes overlapping global approvals and releases the guard after failure=%s",
    async (fail) => {
      const f = fixture();
      const first = f.prepare();
      const second = f.prepare({ ...replacement, enabled: false });
      const persist = f.request.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.request.mockImplementationOnce(async (endpoint, options) => {
        await gate;
        if (fail) throw new Error("fixture failure");
        return persist(endpoint, options);
      });
      const pending = f.approve(first);
      try {
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(await f.approve(second)).toMatchObject({
          ok: false,
          error: expect.stringContaining("al gewijzigd"),
        });
        expect(f.confirmations.has(second.sessionId)).toBe(false);
        expect(f.request).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      expect(await pending).toMatchObject(
        fail ? { ok: false, verified: null } : { ok: true, verified: true },
      );
      expect(await f.approve(second)).toMatchObject({ ok: false });
      expect(await f.approve(f.prepare())).toEqual({
        ok: true,
        verified: true,
      });
    },
  );

  it.each(["prepare", "before_execute"])(
    "blocks writes when %s auditing fails",
    async (phase) => {
      const f = fixture();
      const action = phase === "before_execute" ? f.prepare() : undefined;
      f.record.mockImplementation((entry) => {
        if (phase === "prepare" || entry.phase === phase)
          throw new Error("fixture audit failure");
        return { ...entry, id: "fixture", timestamp: "fixture" };
      });
      expect(
        action ? await f.approve(action) : f.service.prepare(input()),
      ).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.read()).toBe(JSON.stringify(oldPrompt));
      f.record.mockReset().mockImplementation((entry) => ({
        ...entry,
        id: "fixture",
        timestamp: "fixture",
      }));
      expect(await f.approve(f.prepare())).toMatchObject({
        ok: true,
        verified: true,
      });
    },
  );

  it("reports saved and verified state honestly if final auditing fails", async () => {
    const f = fixture();
    const action = f.prepare();
    f.record.mockImplementation((entry) => {
      if (entry.phase === "after_execute")
        throw new Error("fixture audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(await f.approve(action)).toMatchObject({
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
    const action = f.prepare();
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
    expect(await f.approve(action)).toMatchObject({
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
    expect(await f.approve(action)).toMatchObject({ ok: false });
  });

  it.each(["provenance", "configured", "database"])(
    "fails closed before writes for unavailable %s",
    async (failure) => {
      const f = fixture();
      const action = f.prepare();
      if (failure === "provenance")
        f.config.omniUrl = "http://unverified.invalid/v1";
      if (failure === "configured") f.configured.mockReturnValue(false);
      if (failure === "database") f.config.omniDatabase += ".missing";
      expect(f.service.prepare(input())).toMatchObject({ ok: false });
      expect(await f.approve(action)).toMatchObject({ ok: false });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("caps private drafts at twenty and prunes cancellations and expiries", async () => {
    const f = fixture();
    const actions = Array.from({ length: 20 }, () => f.prepare());
    expect(f.service.prepare(input())).toMatchObject({ ok: false });
    expect(await f.approve(actions[0]!, false)).toEqual({ ok: true });
    f.prepare();
    expect(f.service.prepare(input())).toMatchObject({ ok: false });
    f.advance(60000);
    const fresh = f.prepare();
    expect(await f.approve(actions[1]!)).toMatchObject({ ok: false });
    expect(await f.approve(fresh)).toMatchObject({ ok: true, verified: true });
  });

  it("erases private draft contents at sixty seconds without another prepare and frees the cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const privateState = f.service as unknown as {
      drafts: Map<string, { prompt: Prompt }>;
      expiryTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const actions = Array.from({ length: 20 }, () => f.prepare());
    expect(privateState.drafts.size).toBe(20);
    expect(privateState.drafts.get(actions[0]!.confirmationId)?.prompt).toEqual(
      replacement,
    );
    expect(privateState.expiryTimers.size).toBe(20);
    expect(vi.getTimerCount()).toBe(20);
    f.advance(59999);
    vi.advanceTimersByTime(59999);
    expect(privateState.drafts.size).toBe(20);
    f.advance(1);
    vi.advanceTimersByTime(1);
    // Inspect before preparing anything: private contents must disappear autonomously.
    expect(privateState.drafts.size).toBe(0);
    expect(privateState.expiryTimers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const pending = f.confirmations.peek(actions[0]!.sessionId);
    expect(pending?.args).toEqual({
      enabled: true,
      prefixCharacters: replacement.prefixPrompt.length,
      suffixCharacters: replacement.suffixPrompt.length,
    });
    expect(JSON.stringify(pending)).not.toContain(replacement.prefixPrompt);
    expect(JSON.stringify(pending)).not.toContain(replacement.suffixPrompt);
    expect(await f.approve(actions[0]!)).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(Array.from({ length: 20 }, () => f.prepare())).toHaveLength(20);
    expect(privateState.drafts.size).toBe(20);
  });

  it("disposes private drafts and all expiry timers when the module is destroyed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const privateState = f.service as unknown as {
      drafts: Map<string, unknown>;
      expiryTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const action = f.prepare();
    f.prepare();
    expect(privateState.drafts.size).toBe(2);
    expect(privateState.expiryTimers.size).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    f.service.onModuleDestroy();
    expect(privateState.drafts.size).toBe(0);
    expect(privateState.expiryTimers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.approve(action)).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled();
    // Repeated lifecycle cleanup remains safe.
    f.service.onModuleDestroy();
    vi.advanceTimersByTime(60000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("native prompt validation and API guards", () => {
  it.each([
    null,
    [],
    {},
    { ...input(), acknowledgeGlobal: false },
    { ...input(), acknowledgeGlobal: "true" },
    { ...input(), enabled: 1 },
    { ...input(), prefixPrompt: null },
    { ...input(), suffixPrompt: 4 },
    { ...input(), always: true },
    { ...replacement },
  ])("rejects invalid full replacements %j", (value) => {
    const f = fixture();
    expect(() => f.service.prepare(value)).toThrow(ValidationError);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["prefixPrompt", "suffixPrompt"] as const)(
    "enforces 50,000 UTF-16 character bounds for %s including Unicode",
    (key) => {
      const f = fixture();
      expect(
        f.service.prepare(input({ ...replacement, [key]: "🌻".repeat(25000) }))
          .ok,
      ).toBe(true);
      expect(() =>
        f.service.prepare(
          input({ ...replacement, [key]: "🌻".repeat(25000) + "x" }),
        ),
      ).toThrow(ValidationError);
      expect(() =>
        f.service.prepare(input({ ...replacement, [key]: "x".repeat(50001) })),
      ).toThrow(ValidationError);
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
    (secret) => {
      vi.stubEnv("NOVA_FIXTURE_SECRET", "environment-private-value");
      const f = fixture();
      for (const key of ["prefixPrompt", "suffixPrompt"])
        expect(() =>
          f.service.prepare(input({ ...replacement, [key]: secret })),
        ).toThrow(ValidationError);
      expect(f.record).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["chat-session", crypto.randomUUID()],
    [`settings-prompt:${crypto.randomUUID()}`, "bad-id"],
  ])("rejects malformed session/id %s %s", async (session, id) => {
    const f = fixture();
    await expect(f.service.confirm(session, id, true)).rejects.toThrow(
      ValidationError,
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects malformed confirmation bodies and standing consent before delegation", () => {
    const service = { confirm: vi.fn() };
    const controller = new NativePromptController(
      service as unknown as NativePromptService,
    );
    for (const body of [
      null,
      [],
      {},
      { sessionId: "s", confirmationId: "c", approve: "yes" },
      { sessionId: "s", confirmationId: "c", approve: true, always: true },
    ])
      expect(() => controller.confirm(body)).toThrow(ValidationError);
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("requires PIN and admin on real app routes and exposes no model prompt setter", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const service = nova.app.get(NativePromptService);
    const prepare = vi.spyOn(service, "prepare").mockReturnValue({ ok: true });
    const confirm = vi
      .spyOn(service, "confirm")
      .mockResolvedValue({ ok: true });
    try {
      expect(
        nova.tools.forModel().map((tool) => tool.function.name),
      ).not.toContain("native_prompt_replace");
      expect(
        nova.tools
          .forModel()
          .filter((tool) =>
            /native.*prompt|system.?prompt.*set|prompt.*replace/i.test(
              tool.function.name,
            ),
          ),
      ).toEqual([]);
      const confirmation = {
        sessionId: `settings-prompt:${crypto.randomUUID()}`,
        confirmationId: crypto.randomUUID(),
        approve: true,
      };
      for (const [route, body] of [
        ["prepare", input()],
        ["confirm", confirmation],
      ] as const) {
        const endpoint = `/api/settings/omniroute/native/prompt/${route}`;
        expect(
          (await nova.api.post(endpoint).set(ADMIN).send(body)).status,
        ).toBe(401);
        expect(
          (
            await nova.api
              .post(endpoint)
              .set(ADMIN)
              .set("x-nova-pin", "wrong")
              .send(body)
          ).status,
        ).toBe(401);
        expect(
          (await nova.api.post(endpoint).set("x-nova-pin", "4321").send(body))
            .status,
        ).toBe(403);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/native/prompt/prepare")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send(input())
        ).status,
      ).toBe(200);
      expect(
        (
          await nova.api
            .post("/api/settings/omniroute/native/prompt/confirm")
            .set(ADMIN)
            .set("x-nova-pin", "4321")
            .send(confirmation)
        ).status,
      ).toBe(200);
      expect(prepare).toHaveBeenCalledWith(input());
      expect(confirm).toHaveBeenCalledWith(
        confirmation.sessionId,
        confirmation.confirmationId,
        true,
      );
    } finally {
      prepare.mockRestore();
      confirm.mockRestore();
      await nova.app.close();
    }
  });
});
