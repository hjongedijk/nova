import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  ToolSourceProvider,
  type ToolResult,
  type ToolSource,
} from "../../src/tools/tool.types.js";

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
        description: "Restarts",
        parameters: schema({ vmid: integer(100, 999), note: text() }, ["vmid"]),
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
  beforeEach(() => (ran.length = 0));

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
