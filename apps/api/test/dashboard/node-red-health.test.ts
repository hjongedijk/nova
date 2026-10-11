import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { NodeRedHealth } from "../../src/dashboard/node-red-health.service.js";
import type { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import {
  NodeRedManagement,
  projectNodeRedFlowRuns,
} from "../../src/settings/node-red-management.service.js";

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local test address");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

describe("Node-RED health summary", () => {
  it("counts flow tabs but never returns node configuration", async () => {
    let flowReads = 0;
    const { url } = await serve((request, response) => {
      flowReads++;
      expect(request.url).toBe("/flows");
      expect(request.headers["node-red-api-version"]).toBe("v2");
      expect(request.headers.authorization).toBe("Bearer admin-fixture");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          rev: "fixture-revision",
          flows: [
            {
              id: "tab-a",
              type: "tab",
              label: "Kitchen",
              credentials: { secret: "private" },
            },
            { id: "tab-b", type: "tab", label: "Garden" },
            { id: "node-a", type: "inject", z: "tab-a", name: "Private node" },
          ],
        }),
      );
    });
    const health = new NodeRedHealth({
      nodeRedUrl: url,
      nodeRedAdminToken: "admin-fixture",
    } as NovaConfig);
    const first = await health.report();
    expect(first).toEqual({
      online: true,
      flowCount: 2,
      lastError: null,
      lastErrorAvailable: false,
      lastErrorFlowId: null,
    });
    expect(JSON.stringify(first)).not.toMatch(
      /Kitchen|Garden|Private node|secret|fixture-revision/,
    );
    await health.report();
    expect(flowReads).toBe(1);
  });

  it("reports an internal service as online when admin flow access requires authorization", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    const health = new NodeRedHealth({ nodeRedUrl: url } as NovaConfig);
    expect(await health.report()).toEqual({
      online: true,
      flowCount: null,
      lastError: null,
      lastErrorAvailable: false,
      lastErrorFlowId: null,
    });
  });

  it("rejects non-local Node-RED targets without making a request", async () => {
    const health = new NodeRedHealth({
      nodeRedUrl: "http://127.0.0.2:1880",
    } as NovaConfig);
    await expect(health.report()).resolves.toMatchObject({
      online: false,
      flowCount: null,
    });
  });

  it("keeps the latest explicitly reported runtime error in health", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: "tab", type: "tab" }]));
    });
    const health = new NodeRedHealth({ nodeRedUrl: url } as NovaConfig);
    await health.report();
    health.recordRuntimeError("Flow failed");
    await expect(health.report()).resolves.toMatchObject({
      online: true,
      lastError: "Flow failed",
      lastErrorAvailable: true,
      lastErrorFlowId: null,
    });
  });

  it("alerts once when Node-RED becomes unavailable and again when it recovers", async () => {
    let online = true;
    const { url } = await serve((_request, response) => {
      response.writeHead(online ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(
        online ? JSON.stringify([{ id: "tab", type: "tab" }]) : "offline",
      );
    });
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const recordNodeRedAlert = vi.fn();
    const health = new NodeRedHealth(
      { nodeRedUrl: url } as NovaConfig,
      { recordNodeRedAlert } as unknown as AlertsFeed,
    );
    expect((await health.report()).online).toBe(true);
    expect(recordNodeRedAlert).not.toHaveBeenCalled();

    now += 30_001;
    online = false;
    expect((await health.report()).online).toBe(false);
    expect(recordNodeRedAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Node-RED reageert niet",
        severity: "critical",
      }),
    );

    now += 5_001;
    online = true;
    expect((await health.report()).online).toBe(true);
    expect(recordNodeRedAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Node-RED weer bereikbaar",
        severity: "info",
      }),
    );
    expect(recordNodeRedAlert).toHaveBeenCalledTimes(2);
  });
});

describe("Node-RED flow inventory", () => {
  it("projects flow tabs and counts without exposing executable data", async () => {
    const { url } = await serve((request, response) => {
      expect(request.url).toBe("/flows");
      expect(request.headers["node-red-api-version"]).toBe("v2");
      expect(request.headers.authorization).toBe("Bearer admin-fixture");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          rev: "rev-private",
          flows: [
            { id: "tab-a", type: "tab", label: "Kitchen", disabled: true },
            { id: "node-a", type: "function", z: "tab-a", func: "secret code" },
            { id: "tab-b", type: "tab", label: "Garden" },
          ],
        }),
      );
    });
    const service = new NodeRedManagement({
      nodeRedUrl: url,
      nodeRedAdminToken: "admin-fixture",
    } as NovaConfig);
    const report = await service.listFlows();
    expect(report).toEqual({
      revision: "rev-private",
      flows: [
        {
          id: "tab-a",
          label: "Kitchen",
          disabled: true,
          nodeCount: 1,
          lastRun: null,
          lastError: null,
        },
        {
          id: "tab-b",
          label: "Garden",
          disabled: false,
          nodeCount: 0,
          lastRun: null,
          lastError: null,
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /secret code|function|credentials/,
    );
  });

  it("rejects non-local flow endpoints", async () => {
    const service = new NodeRedManagement({
      nodeRedUrl: "http://example.com",
      nodeRedAdminToken: "",
    } as NovaConfig);
    await expect(service.listFlows()).rejects.toThrow(
      "buiten het lokale netwerk",
    );
  });

  it("returns only a configured browser-safe editor URL", async () => {
    const service = new NodeRedManagement({
      nodeRedUrl: "http://node-red:1880",
      nodeRedEditorUrl: "https://flows.example.test/nodered/?token=private",
    } as NovaConfig);
    expect(service.editorUrl()).toBe("https://flows.example.test/nodered");
    const unsafe = new NodeRedManagement({
      nodeRedEditorUrl: "javascript:alert(1)",
    } as NovaConfig);
    expect(unsafe.editorUrl()).toBeNull();
  });

  it("matches runnable tabs only through a valid, unique allowlist mapping", () => {
    const allowlist = JSON.stringify([
      { id: "lights", tabId: "tab-123", label: "Lights", risk: "CONFIRM" },
    ]);
    const service = new NodeRedManagement({
      nodeRedFlowToken: "a-valid-flow-token-with-at-least-32-characters",
      nodeRedFlowAllowlist: allowlist,
    } as NovaConfig);
    expect(service.runnableFlowId("tab-123")).toBe("lights");
    expect(service.runnableFlowId("tab-other")).toBeNull();
    const duplicate = new NodeRedManagement({
      nodeRedFlowToken: "a-valid-flow-token-with-at-least-32-characters",
      nodeRedFlowAllowlist: JSON.stringify([
        { id: "lights", tabId: "tab-123" },
        { id: "lights-two", tabId: "tab-123" },
      ]),
    } as NovaConfig);
    expect(duplicate.runnableFlowId("tab-123")).toBeNull();
  });

  it("projects only the latest completed flow run, without logged arguments", () => {
    const flows = [{ id: "lights", label: "Lights" }];
    const project = (
      timestamp: string,
      confirmation: string,
      result: unknown,
    ) => ({
      id: timestamp,
      timestamp,
      tool: "node_red_flow",
      confirmation,
      arguments: { flow: "lights", payload: { private: "hidden" } },
      result,
    });
    expect(
      projectNodeRedFlowRuns(flows, [
        project("2026-10-11T10:00:00Z", "confirmed", {
          ok: false,
          error: "offline",
        }),
        project("2026-10-11T09:00:00Z", "pending", null),
      ]),
    ).toEqual([
      {
        id: "lights",
        label: "Lights",
        lastRun: "2026-10-11T10:00:00Z",
        lastError: "offline",
      },
    ]);
  });
});
