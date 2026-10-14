import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NodeRedBriefingSource } from "../../src/dashboard/node-red-briefing.source.js";
import {
  projectBriefingInventory,
  projectBriefingSchedules,
} from "../../src/dashboard/node-red-briefing.js";

const servers: Server[] = [];
const NAME = "node_red_briefing_schedule";
const args = {
  nodeId: "briefing-node",
  time: "08:15",
  timezone: "Europe/Amsterdam",
};
const initial = () => [
  { id: "tab-one", type: "tab", label: "Private flow label" },
  {
    id: "briefing-node",
    type: "nova-briefing",
    z: "tab-one",
    kind: "morning_briefing",
    time: "07:00",
    timezone: "UTC",
    x: 130,
    wires: [["other-node"]],
    privateField: "private-node-value",
  },
  {
    id: "other-node",
    type: "http request",
    z: "tab-one",
    token: "private-unrelated-value",
    wires: [[]],
  },
];
type Row = Record<string, unknown>;
async function fixture(adminToken = "") {
  const state = {
    rev: "rev-1",
    flows: initial() as Row[],
    postCount: 0,
    getStatus: 200,
    postStatus: 200,
    readbackMutation: false,
    readbackDenied: false,
    deploymentRevisionMismatch: false,
    authorization: [] as (string | undefined)[],
  };
  const history = { recordVerifiedChange: vi.fn() };
  const server = createServer(async (request, response) => {
    expect(request.url).toBe("/flows");
    expect(request.headers["node-red-api-version"]).toBe("v2");
    state.authorization.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.writeHead(
        state.postCount && state.readbackDenied ? 503 : state.getStatus,
      );
      const flows = structuredClone(state.flows);
      if (state.readbackMutation && state.postCount) flows[2]!.changed = true;
      response.end(
        JSON.stringify(
          state.getStatus === 200
            ? {
                rev:
                  state.deploymentRevisionMismatch && state.postCount
                    ? "rev-third-party"
                    : state.rev,
                flows,
              }
            : { error: "private upstream diagnostics" },
        ),
      );
      return;
    }
    expect(request.headers["node-red-deployment-type"]).toBe("flows");
    state.postCount++;
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    expect(body.rev).toBe(state.rev);
    response.writeHead(state.postStatus);
    if (state.postStatus !== 200) {
      response.end('{"error":"private upstream diagnostics"}');
      return;
    }
    state.flows = body.flows;
    state.rev = "rev-2";
    response.end(JSON.stringify({ rev: state.rev }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const tool = new NodeRedBriefingSource(
    {
      nodeRedUrl: `http://127.0.0.1:${address.port}`,
      nodeRedAdminToken: adminToken,
      nodeRedFlowAllowlist: "",
    } as NovaConfig,
    history as never,
  );
  return { state, history, tool };
}
const call = () => ({ signal: AbortSignal.timeout(5000) });
async function prepared(
  tool: NodeRedBriefingSource,
  input: Record<string, unknown> = args,
) {
  const plan = await tool.prepare(NAME, input, call());
  if ("error" in plan) throw new Error(plan.error);
  return plan;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeIdleConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("fixed Node-RED briefing schedule", () => {
  it("works without HTTP flow mappings or a fictional admin token, preserving every unrelated field", async () => {
    const { tool, state, history } = await fixture();
    expect(tool.definitions()).toMatchObject([
      { name: NAME, risk: "DANGEROUS", allowStandingApproval: false },
    ]);
    const before = structuredClone(state.flows);
    const plan = await prepared(tool);
    expect(plan.risk).toBe("DANGEROUS");
    expect(plan.args.label).toBe(
      "Ochtendbriefing: dagelijks om 08:15 (Europe/Amsterdam)",
    );
    expect(JSON.stringify(plan)).not.toContain("private-");
    expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
      ok: true,
      verified: true,
      accepted: true,
    });
    expect(state.postCount).toBe(1);
    expect(state.authorization.every((value) => value === undefined)).toBe(
      true,
    );
    expect(state.flows).toEqual(
      before.map((row) =>
        row.id === args.nodeId
          ? { ...row, time: args.time, timezone: args.timezone }
          : row,
      ),
    );
    expect(history.recordVerifiedChange).toHaveBeenCalledWith(
      { revision: "rev-1", flows: before },
      { revision: "rev-2", flows: state.flows },
    );
  });
  it("requires its private prepared fingerprint and ignores injected result labels", async () => {
    const { tool, state } = await fixture();
    expect(await tool.execute(NAME, args, call())).toMatchObject({ ok: false });
    expect(state.authorization).toEqual([]);
    const plan = await prepared(tool);
    const result = await tool.execute(
      NAME,
      { ...plan.args, label: "private injected diagnostics" },
      call(),
    );
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain(
      "private injected diagnostics",
    );
  });
  it("keeps accepted-but-unverified status when readback becomes unavailable", async () => {
    const { tool, state } = await fixture();
    const plan = await prepared(tool);
    state.readbackDenied = true;
    expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
      ok: false,
      accepted: true,
      verified: false,
    });
  });
  it("supports events-only wording and optional real bearer authentication", async () => {
    const { tool, state } = await fixture("fixture-admin-bearer");
    const plan = await prepared(tool, { ...args, time: "" });
    expect(plan.args.label).toContain("alleen gebeurtenissen");
    expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
      ok: true,
    });
    expect(
      state.authorization.every(
        (value) => value === "Bearer fixture-admin-bearer",
      ),
    ).toBe(true);
    expect(state.flows[1]!.time).toBe("");
  });
  it.each([401, 403])(
    "honors actual admin denial %s without diagnostic leakage",
    async (status) => {
      const { tool, state } = await fixture();
      state.getStatus = status;
      const plan = await tool.prepare(NAME, args, call());
      expect(plan).toHaveProperty("error");
      expect(JSON.stringify(plan)).not.toContain("private");
      expect(state.postCount).toBe(0);
    },
  );
  it.each([
    { time: "24:00" },
    { time: "8:00" },
    { time: 8 },
    { timezone: "not-a-timezone" },
    { timezone: "+01:00" },
    { timezone: "UTC token=private" },
    { nodeId: "other-node" },
    { nodeId: "missing-node" },
    { kind: "arbitrary-code" },
    { revision: "caller-injected" },
  ])("rejects malformed or foreign arguments %j", async (change) => {
    const { tool, state } = await fixture();
    expect(
      await tool.prepare(NAME, { ...args, ...change }, call()),
    ).toHaveProperty("error");
    expect(state.postCount).toBe(0);
  });
  it.each([
    "revision",
    "same-revision-content",
    "type",
    "kind",
    "tab",
    "duplicate-id",
  ])("rejects stale preparation or ownership change: %s", async (change) => {
    const { tool, state } = await fixture();
    const plan = await prepared(tool);
    if (change === "revision") state.rev = "rev-new";
    if (change === "same-revision-content") state.flows[2]!.changed = true;
    if (change === "type") state.flows[1]!.type = "function";
    if (change === "kind") state.flows[1]!.kind = "arbitrary-code";
    if (change === "tab") state.flows[1]!.z = "foreign-tab";
    if (change === "duplicate-id") state.flows.push({ ...state.flows[1] });
    expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
      ok: false,
    });
    expect(state.postCount).toBe(0);
  });
  it("honors the upstream compare-and-swap conflict", async () => {
    const { tool, state, history } = await fixture();
    const plan = await prepared(tool);
    state.postStatus = 409;
    expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
      ok: false,
    });
    expect(history.recordVerifiedChange).not.toHaveBeenCalled();
    expect(state.flows).toEqual(initial());
  });
  it.each(["content", "revision"])(
    "does not claim verified success for readback %s changes",
    async (change) => {
      const { tool, state, history } = await fixture();
      const plan = await prepared(tool);
      state.readbackMutation = change === "content";
      state.deploymentRevisionMismatch = change === "revision";
      expect(await tool.execute(NAME, plan.args, call())).toMatchObject({
        ok: false,
        accepted: true,
        verified: false,
      });
      expect(history.recordVerifiedChange).not.toHaveBeenCalled();
    },
  );
  it("reports a safe history warning only after successful readback", async () => {
    const { tool, history } = await fixture();
    history.recordVerifiedChange.mockImplementation(() => {
      throw new Error("private-history-file");
    });
    const plan = await prepared(tool);
    const result = await tool.execute(NAME, plan.args, call());
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      historyWarning: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain("private-history-file");
  });
  it.each([
    "http://example.org:1880",
    "http://user:pass@localhost:1880",
    "file:///tmp/flows",
  ])(
    "rejects targets outside the existing local allowlist: %s",
    async (nodeRedUrl) => {
      const tool = new NodeRedBriefingSource({ nodeRedUrl } as NovaConfig);
      expect(tool.definitions()).toEqual([]);
      expect(await tool.prepare(NAME, args, call())).toHaveProperty("error");
    },
  );
});

describe("briefing inventory projection", () => {
  it("projects only bounded schedule fields for an actual unique tab", () => {
    expect(projectBriefingSchedules(initial(), "tab-one")).toEqual([
      {
        id: "briefing-node",
        kind: "morning_briefing",
        time: "07:00",
        timezone: "UTC",
      },
    ]);
    expect(projectBriefingSchedules(initial(), "other-node")).toEqual([]);
    expect(
      projectBriefingSchedules([...initial(), { ...initial()[0] }], "tab-one"),
    ).toEqual([]);
    expect(
      projectBriefingSchedules(
        initial().map((row) =>
          row.id === "briefing-node"
            ? { ...row, timezone: "secret=private" }
            : row,
        ),
        "tab-one",
      ),
    ).toEqual([]);
  });
  it("projects multiple tabs once, handles nodes before tabs and omits private fields", () => {
    const rows = initial();
    const inventory = projectBriefingInventory([
      ...rows.slice(1),
      rows[0],
      {
        ...rows[1],
        id: "evening-node",
        z: "tab-two",
        kind: "evening_review",
        time: "",
        name: "private-schedule-name",
        secret: "private-value",
      },
      { ...rows[1], id: "orphan-node", z: "missing-tab" },
      { id: "tab-two", type: "tab" },
      { id: "empty-tab", type: "tab" },
    ]);
    expect([...inventory.keys()].sort()).toEqual([
      "empty-tab",
      "tab-one",
      "tab-two",
    ]);
    expect(inventory.get("tab-one")).toHaveLength(1);
    expect(inventory.get("tab-two")).toEqual([
      { id: "evening-node", kind: "evening_review", time: "", timezone: "UTC" },
    ]);
    expect(inventory.get("empty-tab")).toEqual([]);
    expect(JSON.stringify([...inventory])).not.toContain("private");
  });
  it("applies the 32 schedule bound independently per tab", () => {
    const inventory = projectBriefingInventory([
      { id: "tab-one", type: "tab" },
      { id: "tab-two", type: "tab" },
      ...Array.from({ length: 34 }, (_, index) => ({
        ...initial()[1],
        id: `overflow-${index}`,
      })),
      ...Array.from({ length: 32 }, (_, index) => ({
        ...initial()[1],
        id: `valid-${index}`,
        z: "tab-two",
      })),
      {
        ...initial()[1],
        id: "invalid-timezone-node",
        z: "tab-two",
        timezone: "secret=private",
      },
    ]);
    expect(inventory.get("tab-one")).toEqual([]);
    expect(inventory.get("tab-two")).toHaveLength(32);
    expect(
      projectBriefingInventory([...initial(), { ...initial()[0] }]).size,
    ).toBe(0);
  });
  it("rejects nonserializable malformed projections", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    expect(projectBriefingSchedules(circular, "tab-one")).toEqual([]);
  });
  it("fails closed above the bounded schedule count", () => {
    const flows = [
      { id: "tab-one", type: "tab" },
      ...Array.from({ length: 33 }, (_, index) => ({
        ...initial()[1],
        id: `briefing-${index}`,
      })),
    ];
    expect(projectBriefingSchedules(flows, "tab-one")).toEqual([]);
  });
});
