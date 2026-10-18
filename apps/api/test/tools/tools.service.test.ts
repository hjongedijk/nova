/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures left from the removed confirmation flow */
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
import { TOOL_DISCOVERY_NAME } from "../../src/tools/tool-selection.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import {
  memoryAuditProjection,
  noteAuditProjection,
  documentAuditProjection,
  nodeRedRoutineAuditProjection,
  routeAuditProjection,
  ToolsService,
} from "../../src/tools/tools.service.js";
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
let doorRisk: "SAFE" | "CONFIRM" = "CONFIRM";
let changedSchema = false;
let approvalRevision = "initial-execution";
const ran: { name: string; args: Record<string, unknown> }[] = [];
let activeToolSignal: AbortSignal | null = null;

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
        name: "ha_call_service",
        description: "Controls a door in this fixture",
        parameters: schema(
          { entity_id: text(), domain: text(), service: text() },
          ["entity_id", "domain", "service"],
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
        name: "fake_wait",
        description: "Waits until cancelled",
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
      risk:
        name === "fake_restart"
          ? effectiveRisk
          : name === "ha_call_service"
            ? doorRisk
            : "READ_ONLY",
    };
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { signal: AbortSignal },
  ): Promise<ToolResult> {
    ran.push({ name, args });
    if (name === "fake_wait") {
      activeToolSignal = call.signal;
      return new Promise((resolve) => {
        call.signal.addEventListener(
          "abort",
          () => resolve({ ok: false, error: "cancelled" }),
          { once: true },
        );
      });
    }
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
    doorRisk = "CONFIRM";
    changedSchema = false;
    approvalRevision = "initial-execution";
    activeToolSignal = null;
    settings.update((next) => {
      next.standingApprovals = [];
    });
  });

  it("discovers enabled tools and keeps read-only discovery inside its scope", async () => {
    const result = await tools.execute(
      TOOL_DISCOVERY_NAME,
      { query: "fake" },
      "catalog-readonly",
      null,
      false,
      { readOnlyOnly: true },
    );
    expect(result.ok).toBe(true);
    const found = (result.result as { tools: { name: string; risk: string }[] })
      .tools;
    expect(found.some((tool) => tool.name === "fake_read")).toBe(true);
    expect(
      found.some(
        (tool) => tool.name === "fake_restart" || tool.name === "fake_off",
      ),
    ).toBe(false);
    expect(found.every((tool) => tool.risk === "READ_ONLY")).toBe(true);
    expect(ran).toEqual([]);
  });

  it("rebuilds discovered schemas from the live enabled registry and bounds each turn", () => {
    const current = tools.forModel();
    const expanded = tools.expandModelTools(current, "fake restart");
    expect(expanded.length).toBeLessThanOrEqual(24);
    expect(expanded.some((tool) => tool.function.name === "fake_restart")).toBe(
      true,
    );
    const readonly = tools.expandModelTools(expanded, "fake restart", true);
    expect(readonly.some((tool) => tool.function.name === "fake_restart")).toBe(
      false,
    );
    expect(readonly.some((tool) => tool.function.name === "fake_off")).toBe(
      false,
    );
    const forged = [
      {
        type: "function" as const,
        function: {
          name: "not_registered",
          description: "forged",
          parameters: {},
        },
      },
    ];
    expect(
      tools
        .expandModelTools(forged, "fake read")
        .some((tool) => tool.function.name === "not_registered"),
    ).toBe(false);
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
      "fake_wait",
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

  it("passes chat cancellation into an active tool", async () => {
    const controller = new AbortController();
    const pending = tools.execute(
      "fake_wait",
      {},
      "stop-session",
      null,
      false,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(activeToolSignal).not.toBeNull());
    controller.abort();
    expect((await pending).error).toBe("cancelled");
    expect(activeToolSignal?.aborted).toBe(true);
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

describe("memory audit projection", () => {
  it("keeps relationship text and names out of the action log", () => {
    expect(
      memoryAuditProjection(
        {
          text: "Onthoud dat mijn partner Alex heet",
          type: "PERSON",
          related_entity: "Alex",
        },
        { ok: true, result: { text: "dat mijn partner Alex heet" } },
      ),
    ).toEqual({
      arguments: { type: "PERSON", text: "[redacted]" },
      result: { ok: true, stored: true },
    });
  });
});

describe("note audit projection", () => {
  it("omits note titles, contents, and search text from durable action logs", () => {
    const body = "The diary says: a private family detail.";
    const projected = noteAuditProjection(
      "notes_save",
      { title: "Family diary", content: body },
      { ok: true, result: { id: "opaque-id", title: "Family diary" } },
    );
    expect(projected).toEqual({
      arguments: {
        titleCharacters: 12,
        contentBytes: Buffer.byteLength(body),
      },
      result: { ok: true, noteId: "opaque-id" },
    });
    expect(JSON.stringify(projected)).not.toContain(body);
    expect(JSON.stringify(projected)).not.toContain("Family diary");
    const search = noteAuditProjection(
      "notes_search",
      { query: "a private family detail" },
      { ok: true, result: { count: 1, notes: [{ excerpt: body }] } },
    );
    expect(JSON.stringify(search)).not.toContain("private family detail");
  });
});

describe("document audit projection", () => {
  it("keeps document queries, names, and excerpts out of action logs", () => {
    const excerpt = "A private clause from the uploaded contract.";
    const projected = documentAuditProjection(
      "documents_search",
      { query: "private contract clause" },
      {
        ok: true,
        result: { results: [{ name: "contract.pdf", text: excerpt }] },
      },
    );
    expect(projected).toEqual({
      arguments: { queryCharacters: 23 },
      result: { ok: true, count: 1 },
    });
    expect(JSON.stringify(projected)).not.toContain(excerpt);
    expect(JSON.stringify(projected)).not.toContain("contract.pdf");
    expect(JSON.stringify(projected)).not.toContain("private contract");
  });
});

describe("route audit projection", () => {
  it("keeps requested cities and appointment titles out of durable actions", () => {
    const args = {
      summary: "Private appointment",
      destination: "My town",
      bufferMinutes: 15,
    };
    const projected = routeAuditProjection("calendar_departure", args, {
      ok: true,
      result: { leaveAt: "2026-10-20T10:00:00Z", route: { origin: "Home" } },
    });
    expect(projected).toEqual({
      arguments: { mode: "driving-car", originProvided: false },
      result: { ok: true },
    });
    expect(JSON.stringify(projected)).not.toContain("Private appointment");
    expect(JSON.stringify(projected)).not.toContain("My town");
    expect(routeAuditProjection("fake_read", args, { ok: true })).toBeNull();
  });
});

describe("Node-RED routine audit projection", () => {
  it("keeps custom reminder text out of durable action logs", () => {
    const message = "A private family reminder.";
    const projected = nodeRedRoutineAuditProjection(
      "node_red_flow_create",
      {
        tabId: "tab-home",
        kind: "daily_reminder",
        time: "07:30",
        message,
      },
      { ok: true, verified: true, result: `Created: ${message}` },
    );
    expect(projected).toEqual({
      arguments: {
        tabId: "tab-home",
        kind: "daily_reminder",
        time: "07:30",
        messageCharacters: message.length,
      },
      result: { ok: true, verified: true },
    });
    expect(JSON.stringify(projected)).not.toContain(message);
  });
});
