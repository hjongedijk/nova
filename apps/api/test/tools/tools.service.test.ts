import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import {
  integer,
  schema,
  text,
  type ToolDefinition,
  type ToolPlan,
  ToolSourceProvider,
  type ToolResult,
  type ToolSource,
} from "../../src/tools/tool.types.js";

let effectiveRisk: "CONFIRM" | "DANGEROUS" = "CONFIRM";
let changedSchema = false;
let approvalRevision = "initial-execution";
const ran: { name: string; args: Record<string, unknown> }[] = [];

@ToolSourceProvider()
class FakeSource implements ToolSource {
  readonly source = "fake";
  definitions(): ToolDefinition[] {
    return [
      {
        name: "fake_read",
        description: "Reads",
        parameters: schema({ vmid: integer(100, 999) }),
        risk: "READ_ONLY",
      },
      {
        name: "fake_restart",
        approvalRevision,
        description: "Restarts",
        parameters: schema(
          {
            vmid: integer(100, 999),
            note: text(),
            ...(changedSchema ? { extra: text() } : {}),
          },
          ["vmid"],
        ),
        risk: "CONFIRM",
      },
      {
        name: "fake_broken",
        description: "Answers nonsense",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "fake_off",
        description: "Not configured",
        parameters: schema(),
        risk: "READ_ONLY",
        enabled: false,
      },
    ];
  }
  async prepare(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPlan> {
    return {
      args,
      risk: name === "fake_restart" ? effectiveRisk : "READ_ONLY",
    };
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    ran.push({ name, args });
    if (name === "fake_broken")
      return { nothing: true } as unknown as ToolResult;
    return { ok: true, result: { name, args } };
  }
}

@Module({ providers: [FakeSource] })
class FakeModule {}

describe("ToolsService", () => {
  let tools: ToolsService;
  let audit: AuditService;
  let confirmations: ConfirmationsService;
  let settings: SettingsStore;

  beforeAll(async () => {
    process.env.JARVIS_ENABLE_ACTIONS = "true";
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, FakeModule],
    }).compile();
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    audit = moduleRef.get(AuditService);
    confirmations = moduleRef.get(ConfirmationsService);
    settings = moduleRef.get(SettingsStore);
  });
  afterAll(() => delete process.env.JARVIS_ENABLE_ACTIONS);
  beforeEach(() => {
    ran.length = 0;
    effectiveRisk = "CONFIRM";
    changedSchema = false;
    approvalRevision = "initial-execution";
    settings.update((next) => {
      next.standingApprovals = [];
    });
  });

  it("finds the source by itself and lists its tools, also the unavailable one", () => {
    // The memory and OmniRoute sources come with the modules ToolsModule imports; only ours are checked here.
    const names = tools
      .list()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("fake_"));
    expect(names).toEqual([
      "fake_read",
      "fake_restart",
      "fake_broken",
      "fake_off",
    ]);
    expect(tools.list().find((tool) => tool.name === "fake_off")?.enabled).toBe(
      false,
    );
    expect(tools.forModel().map((tool) => tool.function.name)).not.toContain(
      "fake_off",
    );
  });

  it("cleans up what models send: numbers as text, empty optionals, made-up fields", async () => {
    const result = await tools.execute(
      "fake_read",
      { vmid: "104", limit: 5 },
      "s1",
    );
    expect(result.ok).toBe(true);
    expect(ran[0]?.args).toEqual({ vmid: 104 });
  });

  it("refuses invalid arguments with a reason, without running anything", async () => {
    const result = await tools.execute("fake_read", { vmid: 5 }, "s1");
    expect(result).toMatchObject({
      ok: false,
      error: "Invalid tool arguments",
    });
    expect(result.details?.[0]).toMatch(/vmid/);
    expect(ran).toHaveLength(0);
  });

  it("asks first for a risky action and runs it only with the matching confirmation", async () => {
    const first = await tools.execute("fake_restart", { vmid: 104 }, "s2");
    expect(first.requiresConfirmation).toBe(true);
    expect(ran).toHaveLength(0);
    const approved = confirmations.take("s2", first.action!.confirmationId)!;
    const other = await tools.execute(
      "fake_restart",
      { vmid: 105 },
      "s2",
      approved,
    );
    expect(other.requiresConfirmation).toBe(true);
    expect(ran).toHaveLength(0);
    const again = confirmations.take("s2")!;
    expect(
      (await tools.execute("fake_restart", { vmid: 105 }, "s2", again)).ok,
    ).toBe(true);
    expect(ran).toEqual([{ name: "fake_restart", args: { vmid: 105 } }]);
    const log = audit.read(10, "s2");
    expect(log.map((entry) => entry.confirmation)).toContain("confirmed");
    expect(log.map((entry) => entry.phase)).toContain("execution_started");
  });

  async function grant(sessionId = "grant", args = { vmid: 104 }) {
    const pending = await tools.execute("fake_restart", args, sessionId);
    const approval = confirmations.take(
      sessionId,
      pending.action!.confirmationId,
    )!;
    const result = await tools.execute(
      "fake_restart",
      approval.args,
      sessionId,
      approval,
      true,
    );
    expect(result.ok).toBe(true);
    return approval;
  }

  it("creates a scoped grant, reuses normalized arguments, audits and revokes it", async () => {
    await grant();
    const rule = settings.get().standingApprovals[0]!;
    expect(rule).toMatchObject({ tool: "fake_restart", scope: '{"vmid":104}' });
    expect(rule.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rule.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await tools.execute("fake_restart", { vmid: "104" }, "reuse"),
    ).toMatchObject({ ok: true, standingApproval: true });
    expect(audit.read(5, "reuse").map((entry) => entry.confirmation)).toContain(
      "standing_approval",
    );
    settings.update((next) => {
      next.standingApprovals = [];
    });
    expect(
      (await tools.execute("fake_restart", { vmid: 104 }, "revoke"))
        .requiresConfirmation,
    ).toBe(true);
  });

  it("invalidates grants and pending approvals when execution revision changes with the same schema", async () => {
    await grant();
    const before = tools
      .forModel()
      .find((tool) => tool.function.name === "fake_restart");
    const pending = await tools.execute(
      "fake_restart",
      { vmid: 105 },
      "revision-pending",
    );
    const approval = confirmations.take(
      "revision-pending",
      pending.action!.confirmationId,
    )!;
    approvalRevision = "changed-endpoint-and-body";
    expect(
      tools.forModel().find((tool) => tool.function.name === "fake_restart"),
    ).toEqual(before);
    expect(
      (await tools.execute("fake_restart", { vmid: 104 }, "revision-reuse"))
        .requiresConfirmation,
    ).toBe(true);
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "revision-pending",
          approval,
          true,
        )
      ).requiresConfirmation,
    ).toBe(true);
    expect(settings.get().standingApprovals).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it("stores only hashes and a sanitized scope, without revision or argument secrets", async () => {
    approvalRevision = "execution-secret-do-not-persist";
    const pending = await tools.execute(
      "fake_restart",
      { vmid: 104, note: "password=argument-secret-do-not-persist" },
      "secret-grant",
    );
    const approval = confirmations.take(
      "secret-grant",
      pending.action!.confirmationId,
    )!;
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "secret-grant",
          approval,
          true,
        )
      ).ok,
    ).toBe(true);
    const saved = JSON.stringify(settings.get().standingApprovals);
    expect(saved).not.toContain("execution-secret-do-not-persist");
    expect(saved).not.toContain("argument-secret-do-not-persist");
    expect(saved).toContain("[redacted]");
    expect(settings.get().standingApprovals[0]).not.toHaveProperty("args");
  });

  it("never broadens grants to different values, new fields, or changed schemas", async () => {
    await grant();
    for (const args of [
      { vmid: 105 },
      { vmid: 104, note: "new scope" },
      { vmid: 104, unexpected: "discarded by coercion" },
    ])
      expect(
        (await tools.execute("fake_restart", args, "different"))
          .requiresConfirmation,
      ).toBe(true);
    changedSchema = true;
    expect(
      (await tools.execute("fake_restart", { vmid: 104 }, "schema"))
        .requiresConfirmation,
    ).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it("re-evaluates dangerous risk and cannot grant dangerous actions", async () => {
    await grant();
    effectiveRisk = "DANGEROUS";
    const pending = await tools.execute(
      "fake_restart",
      { vmid: 104 },
      "danger",
    );
    expect(pending.requiresConfirmation).toBe(true);
    expect(pending.action?.risk).toBe("DANGEROUS");
    settings.update((next) => {
      next.standingApprovals = [];
    });
    const approval = confirmations.take(
      "danger",
      pending.action!.confirmationId,
    )!;
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "danger",
          approval,
          true,
        )
      ).ok,
    ).toBe(true);
    expect(settings.get().standingApprovals).toEqual([]);
  });

  it("rejects stale, mismatched and changed-schema approvals without granting", async () => {
    const pending = await tools.execute("fake_restart", { vmid: 104 }, "stale");
    const approval = confirmations.take(
      "stale",
      pending.action!.confirmationId,
    )!;
    expect(
      (
        await tools.execute(
          "fake_restart",
          { vmid: 105 },
          "stale",
          approval,
          true,
        )
      ).requiresConfirmation,
    ).toBe(true);
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "other",
          approval,
          true,
        )
      ).requiresConfirmation,
    ).toBe(true);
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "stale",
          { ...approval, expiresAt: Date.now() - 1 },
          true,
        )
      ).requiresConfirmation,
    ).toBe(true);
    changedSchema = true;
    expect(
      (
        await tools.execute(
          "fake_restart",
          approval.args,
          "stale",
          approval,
          true,
        )
      ).requiresConfirmation,
    ).toBe(true);
    expect(settings.get().standingApprovals).toEqual([]);
    expect(ran).toHaveLength(0);
  });

  it("does not persist or execute a grant when its audit write fails", async () => {
    const pending = await tools.execute(
      "fake_restart",
      { vmid: 104 },
      "audit-fail",
    );
    const approval = confirmations.take(
      "audit-fail",
      pending.action!.confirmationId,
    )!;
    const record = audit.record.bind(audit);
    const spy = vi.spyOn(audit, "record").mockImplementation((entry) => {
      if (entry.confirmation === "standing_approval_created")
        throw new Error("Audit unavailable");
      return record(entry);
    });
    try {
      expect(
        (
          await tools.execute(
            "fake_restart",
            approval.args,
            "audit-fail",
            approval,
            true,
          )
        ).ok,
      ).toBe(false);
      expect(settings.get().standingApprovals).toEqual([]);
      expect(ran).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("expiry and wrong IDs cannot consume an approval", async () => {
    const pending = await tools.execute(
      "fake_restart",
      { vmid: 104 },
      "expiry",
    );
    expect(confirmations.take("expiry", "wrong-id")).toBeNull();
    const previousNow = confirmations.now;
    confirmations.now = () => pending.action!.expiresAt;
    try {
      expect(
        confirmations.take("expiry", pending.action!.confirmationId),
      ).toBeNull();
      expect(
        confirmations.take("expiry", pending.action!.confirmationId),
      ).toBeNull();
    } finally {
      confirmations.now = previousNow;
    }
    expect(ran).toHaveLength(0);
  });

  it("a tool the user switched off cannot run, and an edited description reaches the model", async () => {
    settings.update((next) => {
      next.toolOverrides.fake_read = { enabled: false };
      next.toolOverrides.fake_broken = { description: "Mijn uitleg" };
    });
    expect((await tools.execute("fake_read", { vmid: 104 }, "s3")).ok).toBe(
      false,
    );
    const broken = tools.list().find((tool) => tool.name === "fake_broken")!;
    expect(broken).toMatchObject({
      description: "Mijn uitleg",
      defaultDescription: "Answers nonsense",
      edited: true,
    });
    settings.update((next) => (next.toolOverrides = {}));
  });

  it("an answer without ok is refused, and every call is logged", async () => {
    const result = await tools.execute("fake_broken", {}, "s4");
    expect(result).toEqual({ ok: false, error: "Malformed tool response" });
    expect(audit.read(5, "s4")[0]).toMatchObject({
      tool: "fake_broken",
      result: { ok: false },
    });
  });

  it("an unknown browser tool points the model to what does exist", async () => {
    const result = await tools.execute("browser_open", {}, "s5");
    expect(result.hint).toMatch(/windows_search/);
  });

  it("dashboard polling runs only whitelisted read-only tools, without logging", async () => {
    expect((await tools.executeQuiet("fake_read")).error).toBe(
      "Not a dashboard tool",
    );
  });
});
