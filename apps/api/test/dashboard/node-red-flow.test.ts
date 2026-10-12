import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NodeRedFlowSource } from "../../src/dashboard/node-red-flow.source.js";

const servers: Server[] = [];
const token = "flow-token-012345678901234567890123456789";

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return address.port;
}

function source(port: number, allowlist: string) {
  return new NodeRedFlowSource({
    nodeRedUrl: `http://127.0.0.1:${port}`,
    nodeRedFlowToken: token,
    nodeRedFlowAllowlist: allowlist,
  } as NovaConfig);
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("Node-RED flow tool", () => {
  it("fails closed for malformed entries, duplicate ids and missing token", () => {
    const malformed = source(
      1880,
      '[{"id":"../../x","label":"x","risk":"SAFE"}]',
    );
    const duplicate = source(
      1880,
      '[{"id":"lights","label":"A","risk":"SAFE"},{"id":"lights","label":"B","risk":"CONFIRM"}]',
    );
    const noToken = new NodeRedFlowSource({
      nodeRedFlowAllowlist: '[{"id":"lights","label":"Lights","risk":"SAFE"}]',
      nodeRedFlowToken: "short",
    } as NovaConfig);
    expect(malformed.definitions()).toEqual([]);
    expect(duplicate.definitions()).toEqual([]);
    expect(noToken.definitions()).toEqual([]);
  });

  it("applies the configured risk and posts bounded parameters to the fixed route", async () => {
    let received: unknown;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/_nova/flow/lights_on");
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true, detail: "done" }));
      });
    });
    const port = await listen(server);
    const tool = source(
      port,
      '[{"id":"lights_on","label":"Turn on lights","risk":"CONFIRM","description":"Turn on configured lights"}]',
    );
    expect(tool.definitions()).toHaveLength(1);
    const plan = await tool.prepare("node_red_flow", {
      flow: "lights_on",
      payload: { room: "kitchen" },
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan).toMatchObject({ risk: "CONFIRM" });
    const result = await tool.execute("node_red_flow", plan.args, {
      signal: AbortSignal.timeout(2000),
    });
    expect(received).toEqual({ room: "kitchen" });
    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      verified: null,
      status: 200,
      result: '{"accepted":true,"detail":"done"}',
    });
  });

  it("rejects oversized arguments and never forwards a caller-selected URL", async () => {
    const unused = createServer();
    const port = await listen(unused);
    const tool = source(
      port,
      '[{"id":"safe","label":"Safe flow","risk":"READ_ONLY"}]',
    );
    await expect(
      tool.prepare("node_red_flow", {
        flow: "safe",
        payload: { data: "x".repeat(5000) },
      }),
    ).resolves.toMatchObject({
      error: "Flow parameters are invalid or too large",
    });
    expect(
      await tool.prepare("node_red_flow", {
        flow: "missing",
        payload: {},
      }),
    ).toEqual({ error: "Flow is not allow-listed" });
  });

  it("refuses oversized flow responses", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "x".repeat(20_000) }));
    });
    const port = await listen(server);
    const tool = source(
      port,
      '[{"id":"status","label":"Status","risk":"READ_ONLY"}]',
    );
    const result = await tool.execute(
      "node_red_flow",
      { flow: "status", payload: {} },
      { signal: AbortSignal.timeout(2000) },
    );
    expect(result).toEqual({
      ok: false,
      error: "Node-RED did not return a flow result",
    });
  });

  it("changes only the allow-listed tab state using revision-safe deployment", async () => {
    let rev = "rev-1";
    let flows: unknown[] = [
      { id: "tab-lights", type: "tab", label: "Lights", disabled: false },
      { id: "inject-lights", type: "inject", z: "tab-lights" },
      { id: "tab-other", type: "tab", label: "Other", disabled: false },
    ];
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(
        "Bearer admin-fixture-01234567890123456789",
      );
      expect(request.headers["node-red-api-version"]).toBe("v2");
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev, flows }));
        return;
      }
      expect(request.method).toBe("POST");
      expect(request.headers["node-red-deployment-type"]).toBe("flows");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(body.rev).toBe(rev);
        const changed = body.flows.find(
          (flow: { id: string }) => flow.id === "tab-lights",
        );
        expect(changed.disabled).toBe(true);
        expect(
          body.flows.find((flow: { id: string }) => flow.id === "tab-other")
            .disabled,
        ).toBe(false);
        flows = body.flows;
        rev = "rev-2";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev }));
      });
    });
    const port = await listen(server);
    const tool = new NodeRedFlowSource({
      nodeRedUrl: `http://127.0.0.1:${port}`,
      nodeRedFlowToken: token,
      nodeRedAdminToken: "admin-fixture-01234567890123456789",
      nodeRedFlowAllowlist:
        '[{"id":"lights","label":"Lights","risk":"CONFIRM","tabId":"tab-lights"}]',
    } as NovaConfig);
    expect(tool.definitions().map((item) => item.name)).toEqual([
      "node_red_flow",
      "node_red_flow_state",
    ]);
    const plan = await tool.prepare("node_red_flow_state", {
      tabId: "tab-lights",
      enabled: false,
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.risk).toBe("DANGEROUS");
    expect(
      await tool.prepare("node_red_flow_state", {
        tabId: "tab-other",
        enabled: false,
      }),
    ).toEqual({ error: "Node-RED flow state is not allow-listed" });
    const result = await tool.execute("node_red_flow_state", plan.args, {
      signal: AbortSignal.timeout(5000),
    });
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      result: "Flow disabled",
    });
  });

  it("creates only the fixed error-alert node chain after allowlist preparation", async () => {
    const tabId = "tab-backup";
    let flows: unknown[] = [
      { id: tabId, type: "tab", label: "Backups", disabled: false },
      { id: "backup-inject", type: "inject", z: tabId, wires: [[]] },
    ];
    let rev = "rev-1";
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev, flows }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(body.rev).toBe(rev);
        const added = body.flows.filter(
          (flow: { id: string }) =>
            !flows.some((before) => (before as { id: string }).id === flow.id),
        );
        expect(added).toHaveLength(3);
        expect(added.map((node: { type: string }) => node.type)).toEqual([
          "catch",
          "change",
          "nova-notify",
        ]);
        expect(added.every((node: { z: string }) => node.z === tabId)).toBe(
          true,
        );
        expect(added[1].rules[0]).toMatchObject({
          t: "set",
          p: "payload",
          tot: "jsonata",
        });
        expect(added[1].rules[0].to).toContain(
          "$substring(error.message,0,160)",
        );
        flows = body.flows;
        rev = "rev-2";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev }));
      });
    });
    const port = await listen(server);
    const tool = new NodeRedFlowSource({
      nodeRedUrl: `http://127.0.0.1:${port}`,
      nodeRedAdminToken: "admin-fixture-01234567890123456789",
      nodeRedEventToken: "event-fixture-01234567890123456789",
      nodeRedFlowAllowlist:
        '[{"id":"backup","label":"Backups","risk":"CONFIRM","tabId":"tab-backup"}]',
    } as NovaConfig);
    const prepared = await tool.prepare("node_red_flow_create", {
      flow: tabId,
      kind: "alert_on_error",
    });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared).toMatchObject({
      risk: "DANGEROUS",
      args: { tabId, label: "Backups", kind: "alert_on_error" },
    });
    expect(
      await tool.prepare("node_red_flow_create", {
        flow: "tab-other",
        kind: "alert_on_error",
      }),
    ).toEqual({ error: "Node-RED flow creation is not allow-listed" });
    const result = await tool.execute("node_red_flow_create", prepared.args, {
      signal: AbortSignal.timeout(5000),
    });
    expect(result).toMatchObject({ ok: true, verified: true });
    expect((result as { result: string }).result).toContain("Backups");
  });

  it("installs the scoped offline-status template and filters status noise", async () => {
    const tabId = "tab-home";
    let rev = "rev-1";
    let flows: unknown[] = [
      { id: tabId, type: "tab", label: "Home", disabled: false },
      { id: "home-node", type: "inject", z: tabId, wires: [[]] },
      { id: "other-node", type: "inject", z: "tab-other", wires: [[]] },
    ];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev, flows }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const added = body.flows.filter(
          (flow: { id: string }) =>
            !flows.some((before) => (before as { id: string }).id === flow.id),
        );
        expect(added.map((node: { type: string }) => node.type)).toEqual([
          "status",
          "switch",
          "change",
          "nova-notify",
        ]);
        expect(added[0].scope).toEqual(["home-node"]);
        expect(added[1].rules[0].v).toBe("disconnected|offline|error");
        expect(added[2].rules[0].tot).toBe("jsonata");
        flows = body.flows;
        rev = "rev-2";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev }));
      });
    });
    const port = await listen(server);
    const tool = new NodeRedFlowSource({
      nodeRedUrl: `http://127.0.0.1:${port}`,
      nodeRedAdminToken: "admin-fixture-01234567890123456789",
      nodeRedEventToken: "event-fixture-01234567890123456789",
      nodeRedFlowAllowlist:
        '[{"id":"home","label":"Home","risk":"CONFIRM","tabId":"tab-home"}]',
    } as NovaConfig);
    const plan = await tool.prepare("node_red_flow_create", {
      flow: tabId,
      kind: "alert_on_offline",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan).toMatchObject({ risk: "DANGEROUS" });
    const result = await tool.execute("node_red_flow_create", plan.args, {
      signal: AbortSignal.timeout(5000),
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((result as { result: string }).result).toContain("offline-status");
  });

  it("installs a daily briefing flow at the validated local clock time", async () => {
    const tabId = "tab-morning";
    let rev = "rev-1";
    let flows: unknown[] = [
      { id: tabId, type: "tab", label: "Automation", disabled: false },
    ];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev, flows }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const evening = flows.some(
          (node) =>
            (node as { name?: string }).name ===
            "NOVA generated morning_briefing",
        );
        const added = body.flows.filter(
          (flow: { id: string }) =>
            !flows.some((before) => (before as { id: string }).id === flow.id),
        );
        expect(added.map((node: { type: string }) => node.type)).toEqual([
          "inject",
          "change",
          "nova-ask",
          "change",
          "nova-notify",
        ]);
        expect(added[0].crontab).toBe(evening ? "30 20 * * *" : "45 7 * * *");
        expect(added[2].name).toBe(
          evening
            ? "Ask NOVA for evening review"
            : "Ask NOVA for morning briefing",
        );
        expect(added[2].proactive).toBe(true);
        expect(added[1].rules[0].to).toContain(
          evening ? "daily_briefing.activity.entries" : "ochtendbriefing",
        );
        expect(added[3].rules[0].to).toContain("$substring(payload,0,240)");
        expect(added[3].rules[0].to).toContain('"category":"briefing"');
        flows = body.flows;
        rev = "rev-2";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev }));
      });
    });
    const port = await listen(server);
    const tool = new NodeRedFlowSource({
      nodeRedUrl: `http://127.0.0.1:${port}`,
      nodeRedAdminToken: "admin-fixture-01234567890123456789",
      nodeRedEventToken: "event-fixture-01234567890123456789",
      nodeRedFlowAllowlist:
        '[{"id":"automation","label":"Automation","risk":"CONFIRM","tabId":"tab-morning"}]',
    } as NovaConfig);
    expect(
      await tool.prepare("node_red_flow_create", {
        flow: tabId,
        kind: "morning_briefing",
        time: "24:00",
      }),
    ).toEqual({ error: "Node-RED flow creation is not allow-listed" });
    expect(
      await tool.prepare("node_red_flow_create", {
        flow: tabId,
        kind: "evening_review",
      }),
    ).toEqual({ error: "Node-RED flow creation is not allow-listed" });
    const plan = await tool.prepare("node_red_flow_create", {
      flow: tabId,
      kind: "morning_briefing",
      time: "07:45",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan).toMatchObject({
      risk: "DANGEROUS",
      args: { tabId, kind: "morning_briefing", time: "07:45" },
    });
    const result = await tool.execute("node_red_flow_create", plan.args, {
      signal: AbortSignal.timeout(5000),
    });
    expect(result).toMatchObject({ ok: true, verified: true });
    expect((result as { result: string }).result).toContain("07:45");

    const eveningPlan = await tool.prepare("node_red_flow_create", {
      flow: tabId,
      kind: "evening_review",
      time: "20:30",
    });
    if ("error" in eveningPlan) throw new Error(eveningPlan.error);
    const eveningResult = await tool.execute(
      "node_red_flow_create",
      eveningPlan.args,
      { signal: AbortSignal.timeout(5000) },
    );
    expect(eveningResult).toMatchObject({ ok: true, verified: true });
    expect((eveningResult as { result: string }).result).toContain("20:30");
    expect((eveningResult as { result: string }).result).toContain(
      "evening overview",
    );
  });

  it("creates a user-defined daily reminder from fixed safe Node-RED nodes", async () => {
    const tabId = "tab-routines";
    let flows: unknown[] = [
      { id: tabId, type: "tab", label: "Routines", disabled: false },
    ];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev: "rev-1", flows }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const added = body.flows.filter(
          (flow: { id: string }) =>
            !flows.some((before) => (before as { id: string }).id === flow.id),
        );
        expect(added.map((node: { type: string }) => node.type)).toEqual([
          "inject",
          "change",
          "nova-notify",
        ]);
        expect(added[0].crontab).toBe("45 7 * * *");
        expect(added[1].rules[0].to).toContain("Zet de afvalcontainer buiten.");
        expect(
          added.some((node: { type: string }) => node.type === "function"),
        ).toBe(false);
        flows = body.flows;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rev: "rev-2" }));
      });
    });
    const port = await listen(server);
    const tool = new NodeRedFlowSource({
      nodeRedUrl: `http://127.0.0.1:${port}`,
      nodeRedAdminToken: "admin-fixture-01234567890123456789",
      nodeRedEventToken: "event-fixture-01234567890123456789",
      nodeRedFlowAllowlist:
        '[{"id":"routines","label":"Routines","risk":"CONFIRM","tabId":"tab-routines"}]',
    } as NovaConfig);
    expect(
      await tool.prepare("node_red_flow_create", {
        flow: tabId,
        kind: "daily_reminder",
        time: "24:00",
        message: "Zet de afvalcontainer buiten.",
      }),
    ).toEqual({ error: "Node-RED flow creation is not allow-listed" });
    const plan = await tool.prepare("node_red_flow_create", {
      flow: tabId,
      kind: "daily_reminder",
      time: "07:45",
      message: "Zet de afvalcontainer buiten.",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan).toMatchObject({
      risk: "DANGEROUS",
      args: {
        tabId,
        kind: "daily_reminder",
        time: "07:45",
        message: "Zet de afvalcontainer buiten.",
      },
    });
    const result = await tool.execute("node_red_flow_create", plan.args, {
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ ok: true, verified: true });
    expect((result as { result: string }).result).toContain("daily reminder");
  });
});
