import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import { ToolUsageController } from "../../src/settings/tool-usage.controller.js";
import { createApp } from "./helpers.js";

const first = "2026-10-10T10:00:00.000Z";
const latest = "2026-10-10T11:00:00.000Z";
const tool = (name = "echo", extra = {}) => ({
  name,
  source: "fixture",
  risk: "SAFE",
  enabled: true,
  description: "private-description",
  parameters: { secret: "private-schema" },
  ...extra,
});
const row = (extra = {}) => ({
  timestamp: first,
  tool: "echo",
  durationMs: 100,
  result: {
    ok: true,
    verification: "private-verification",
    error: "private-error",
    secret: "private-result",
  },
  sessionId: "private-session",
  arguments: { secret: "private-arguments" },
  id: "private-id",
  ...extra,
});
function fixture(
  registry: unknown = [tool(), tool("unused", { enabled: false })],
  entries: unknown = [],
) {
  const audit = { read: vi.fn(() => entries), record: vi.fn() };
  const tools = {
    list: vi.fn(() => registry),
    execute: vi.fn(),
    executeQuiet: vi.fn(),
  };
  const controller = new ToolUsageController(
    audit as unknown as AuditService,
    tools as unknown as ToolsService,
  );
  return { controller, audit, tools };
}

describe("private bounded tool usage", () => {
  it("aggregates terminal attempts once and includes untouched current tools", () => {
    const { controller, audit, tools } = fixture(undefined, [
      row(),
      row({ timestamp: latest, durationMs: 50, result: { ok: false } }),
      row({ phase: "execution_started" }),
      row({ result: { ok: true, requiresConfirmation: true } }),
    ]);
    const report = controller.report();
    expect(report).toEqual({
      scannedEntries: 4,
      entryLimit: 500,
      logByteLimit: 2_000_000,
      activityLimit: 50,
      oldestAt: first,
      latestAt: latest,
      toolsTruncated: false,
      recentActivity: [
        {
          at: first,
          tool: "echo",
          source: "fixture",
          context: "chat",
          ok: true,
        },
        {
          at: latest,
          tool: "echo",
          source: "fixture",
          context: "chat",
          ok: false,
          errorType: "other",
        },
      ],
      tools: [
        {
          name: "echo",
          source: "fixture",
          risk: "SAFE",
          enabled: true,
          attempts: 2,
          okResults: 1,
          failedResults: 1,
          lastAt: latest,
          averageDurationMs: 75,
          contexts: { chat: 2, settings: 0, background: 0, unknown: 0 },
        },
        {
          name: "unused",
          source: "fixture",
          risk: "SAFE",
          enabled: false,
          attempts: 0,
          okResults: 0,
          failedResults: 0,
          lastAt: null,
          averageDurationMs: null,
          contexts: { chat: 0, settings: 0, background: 0, unknown: 0 },
        },
      ],
    });
    expect(audit.read.mock.calls).toEqual([[500]]);
    expect(tools.list).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
    expect(tools.execute).not.toHaveBeenCalled();
    expect(tools.executeQuiet).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it("projects only fixed context buckets and no session identifiers", () => {
    const sessions: unknown[] = [
      "health",
      "overview",
      "dashboard",
      "sidebar",
      "settings",
      "settings:private-token",
      "private-chat",
      "health-private",
      "",
      "  ",
      null,
      3,
      {},
    ];
    const report = fixture(
      [tool()],
      sessions.map((sessionId) => row({ sessionId })),
    ).controller.report();
    expect(report.tools[0]!.contexts).toEqual({
      background: 4,
      settings: 2,
      chat: 2,
      unknown: 5,
    });
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it("keeps bounded activity for deleted tools without adding them to current totals", () => {
    const report = fixture(
      [tool()],
      [
        row({ tool: "deleted", timestamp: latest }),
        row({ timestamp: first }),
        row({ timestamp: "2026-02-30T00:00:00.000Z" }),
      ],
    ).controller.report();
    expect(report).toMatchObject({
      scannedEntries: 3,
      oldestAt: first,
      latestAt: latest,
    });
    expect(report.tools[0]!.attempts).toBe(1);
    expect(report.recentActivity[0]).toMatchObject({
      tool: "deleted",
      source: "removed or unavailable",
      ok: true,
    });
  });
  it("shows safe failure categories in recent activity, never raw errors or arguments", () => {
    const report = fixture(
      [tool()],
      [
        row({
          result: {
            ok: false,
            error: "ETIMEDOUT for private@example.test using private-token",
          },
        }),
      ],
    ).controller.report();
    expect(report.recentActivity).toEqual([
      {
        at: first,
        tool: "echo",
        source: "fixture",
        context: "chat",
        ok: false,
        errorType: "timeout",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("private@");
    expect(JSON.stringify(report)).not.toContain("private-token");
  });
  it.each([
    undefined,
    null,
    "invalid",
    "2026-10-10",
    "2026-10-10T10:00:00Z",
    "2026-10-10T10:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z",
    "2026-10-10T10:00:00.000z",
    {},
    NaN,
  ])("ignores malformed timestamp: %j", (timestamp) => {
    const report = fixture([tool()], [row({ timestamp })]).controller.report();
    expect(report.tools[0]!.attempts).toBe(0);
    expect(report.oldestAt).toBeNull();
    expect(report.latestAt).toBeNull();
  });
  it.each([undefined, null, "100", -1, Infinity, NaN, 3_600_001, {}])(
    "ignores invalid duration: %j",
    (durationMs) =>
      expect(
        fixture([tool()], [row({ durationMs })]).controller.report().tools[0]!
          .attempts,
      ).toBe(0),
  );
  it("accepts bounded zero and fractional durations without claiming physical verification", () => {
    const report = fixture(
      [tool()],
      [
        row({ durationMs: 0, result: { ok: true, verified: false } }),
        row({ durationMs: 0.5, result: { ok: false, verified: true } }),
        row({ durationMs: 3_600_000 }),
      ],
    ).controller.report();
    expect(report.tools[0]).toMatchObject({
      attempts: 3,
      okResults: 2,
      failedResults: 1,
      averageDurationMs: 1_200_000 + 0.5 / 3,
    });
    expect(report.tools[0]).not.toHaveProperty("verified");
  });
  it.each([null, undefined, [], true, "ok", {}, { ok: "true" }, { ok: 1 }])(
    "ignores malformed terminal result: %j",
    (result) =>
      expect(
        fixture([tool()], [row({ result })]).controller.report().tools[0]!
          .attempts,
      ).toBe(0),
  );
  it.each([
    "pending",
    "cancelled",
    "canceled",
    "expired",
    "standing_approval_created",
    "replaced",
    "superseded",
  ])(
    "ignores %s records even if decorated with a terminal-looking result",
    (confirmation) =>
      expect(
        fixture([tool()], [row({ confirmation })]).controller.report().tools[0]!
          .attempts,
      ).toBe(0),
  );
  it("excludes all explicit phases including malformed null and ignores unknown/deleted tools", () => {
    const report = fixture(
      [tool()],
      [
        row({ phase: "before_execute" }),
        row({ phase: null }),
        row({ phase: "execution_started" }),
        row({ tool: "deleted" }),
        null,
        [],
        "private-record",
      ],
    ).controller.report();
    expect(report.scannedEntries).toBe(7);
    expect(report.tools[0]!.attempts).toBe(0);
  });
  it("caps audit scan and registry metadata at 500 entries", () => {
    const { controller, audit } = fixture(
      Array.from({ length: 501 }, (_, index) => tool(`tool_${index}`)),
      Array.from({ length: 501 }, () => row({ tool: "tool_0" })),
    );
    const report = controller.report();
    expect(report.scannedEntries).toBe(500);
    expect(report.tools).toHaveLength(500);
    expect(report.toolsTruncated).toBe(true);
    expect(report.tools[0]!.attempts).toBe(500);
    expect(audit.read).toHaveBeenCalledWith(500);
  });
  it("rejects malformed registry metadata and duplicate names, sanitizes and bounds source", () => {
    const registry = [
      tool(),
      tool(),
      null,
      [],
      tool("bad name"),
      tool("sk-abcdefghijklmno"),
      tool("long".repeat(20)),
      tool("risk", { risk: "UNSAFE" }),
      tool("enabled", { enabled: "true" }),
      tool("source", { source: {} }),
      tool("safe", { source: "Bearer private-source " + "x".repeat(120) }),
    ];
    const report = fixture(registry).controller.report();
    expect(report.tools.map(({ name }) => name)).toEqual(["echo", "safe"]);
    expect(report.tools[1]!.source).toHaveLength(100);
    expect(report.tools[1]!.source).toMatch(/^\[redacted\]/);
    expect(JSON.stringify(report)).not.toContain("private");
  });
  it("keeps markup as plain source text for the UI to escape", () => {
    const report = fixture([
      tool("echo", { source: "<script>alert(1)</script>" }),
    ]).controller.report();
    expect(report.tools[0]!.source).toBe("<script>alert(1)</script>");
  });
  it.each([null, {}, "private-log-path"])(
    "fails generically on malformed source: %j",
    (entries) => {
      const { controller } = fixture([tool()], entries);
      expect(() => controller.report()).toThrow(ServiceUnavailableException);
      expect(() => controller.report()).toThrow(
        "Toolgebruik is niet beschikbaar",
      );
    },
  );
  it.each(["audit", "registry"])("hides raw %s failures", (source) => {
    const { controller, audit, tools } = fixture();
    const fail = () => {
      throw new Error("private-log-path /private/actions.jsonl private-token");
    };
    if (source === "audit") audit.read.mockImplementation(fail);
    else tools.list.mockImplementation(fail);
    try {
      controller.report();
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toBe(
        "Toolgebruik is niet beschikbaar. Probeer het later opnieuw.",
      );
    }
  });
});

describe("tool usage API guard", () => {
  it("requires the PIN before audit access and exposes no usage through public settings", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const audit = nova.app.get(AuditService);
    const read = vi.spyOn(audit, "read").mockReturnValue([row() as never]);
    const execute = vi.spyOn(nova.tools, "execute");
    try {
      const route = "/api/settings/tools/usage";
      expect((await nova.api.get(route)).status).toBe(401);
      expect(
        (await nova.api.get(route).set("x-nova-pin", "wrong")).status,
      ).toBe(401);
      expect(read).not.toHaveBeenCalled();
      const report = await nova.api.get(route).set("x-nova-pin", "4321");
      expect(report.status).toBe(200);
      expect(report.body).toMatchObject({
        scannedEntries: 1,
        entryLimit: 500,
        logByteLimit: 2_000_000,
        activityLimit: 50,
        recentActivity: [
          {
            tool: "echo",
            source: expect.any(String),
            ok: true,
          },
        ],
      });
      expect(
        report.body.tools.find(
          (entry: { name: string }) => entry.name === "echo",
        ),
      ).toMatchObject({ attempts: 1, okResults: 1 });
      expect(JSON.stringify(report.body)).not.toContain("private");
      read.mockClear();
      const publicSettings = await nova.api.get("/api/settings/public");
      expect(publicSettings.status).toBe(200);
      expect(publicSettings.body).not.toHaveProperty("usage");
      expect(JSON.stringify(publicSettings.body)).not.toContain("okResults");
      expect(read).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      read.mockImplementation(() => {
        throw new Error("private-log-path");
      });
      const failure = await nova.api.get(route).set("x-nova-pin", "4321");
      expect(failure.status).toBe(503);
      expect(JSON.stringify(failure.body)).not.toContain("private-log-path");
    } finally {
      read.mockRestore();
      execute.mockRestore();
      await nova.app.close();
    }
  });
});
