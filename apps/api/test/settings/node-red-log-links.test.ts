import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
import { requestJson } from "../../src/core/http/http-json.js";
import { StackControlController } from "../../src/settings/stack-control.controller.js";
import { StackControlService } from "../../src/settings/stack-control.service.js";
import { ADMIN, createApp } from "./helpers.js";
import { registerSecrets } from "../../src/core/security/sanitize.js";
import { SettingsGuard } from "../../src/settings/settings.guard.js";
vi.mock("../../src/core/http/http-json.js", () => ({ requestJson: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const sources = [
  { type: "function", label: "work" },
  { type: "http request", label: "node-b" },
  null,
];
function management(flows: unknown, status = 200) {
  vi.mocked(requestJson).mockResolvedValue({
    status,
    data: { flows },
  } as never);
  return new NodeRedManagement({
    nodeRedUrl: "http://node-red:1880",
    nodeRedAdminToken: "fixture",
  } as never);
}
describe("Node-RED log flow links", () => {
  it("links only unique current source matches and projects no configuration", async () => {
    const service = management([
      { id: "flow-a", type: "tab", password: "private-config" },
      {
        id: "node-a",
        type: "function",
        name: "work",
        z: "flow-a",
        func: "private-source",
      },
      { id: "node-b", type: "http request", z: "flow-a" },
    ]);
    expect(await service.resolveLogSources(sources)).toEqual({
      available: true,
      flowIds: ["flow-a", "flow-a", null],
    });
    expect(vi.mocked(requestJson).mock.calls[0]?.[1]).toMatchObject({
      maxResponseBytes: 800000,
      headers: {
        "Node-RED-API-Version": "v2",
        authorization: "Bearer fixture",
      },
    });
  });
  it("does not guess between duplicate names, wrong types or missing tabs", async () => {
    const service = management([
      { id: "flow-a", type: "tab" },
      { id: "a", type: "function", name: "work", z: "flow-a" },
      { id: "b", type: "function", name: "work", z: "flow-a" },
      { id: "node-b", type: "http request", z: "missing" },
    ]);
    expect(await service.resolveLogSources(sources)).toEqual({
      available: true,
      flowIds: [null, null, null],
    });
  });
  it.each([401, 403, 500])(
    "preserves logs when Admin API status is %i",
    async (status) => {
      expect(await management([], status).resolveLogSources(sources)).toEqual({
        available: false,
        flowIds: [null, null, null],
      });
    },
  );
  it.each([
    [
      { id: "duplicate", type: "tab" },
      { id: "duplicate", type: "function" },
    ],
    [{ id: "bad/id", type: "tab" }],
    null,
  ])("rejects invalid complete inventories", async (flows) => {
    expect((await management(flows).resolveLogSources(sources)).available).toBe(
      false,
    );
  });
  it("avoids Admin API work when no log contains a source", async () => {
    const service = management([]);
    expect(await service.resolveLogSources([null])).toEqual({
      available: false,
      flowIds: [null],
    });
    expect(requestJson).not.toHaveBeenCalled();
  });
  it("keeps the endpoint behind the existing settings guard", () => {
    expect(Reflect.getMetadata("__guards__", StackControlController)).toContain(
      SettingsGuard,
    );
  });
  it("joins only projected flow IDs onto sanitized broker entries", async () => {
    const entry = {
      at: "2026-10-15T00:00:00Z",
      text: "[error] [function:work] failed",
      source: sources[0],
    };
    const logs = {
      available: true,
      entries: [entry],
      limited: true,
      truncated: false,
    };
    const resolveLogSources = vi
      .fn()
      .mockResolvedValue({ available: true, flowIds: ["flow-a"] });
    const controller = new StackControlController(
      { nodeRedLogs: async () => logs } as never,
      { resolveLogSources } as never,
    );
    expect(await controller.nodeRedLogs()).toEqual({
      ...logs,
      flowLinksAvailable: true,
      entries: [{ ...entry, flowId: "flow-a" }],
    });
    expect(resolveLogSources).toHaveBeenCalledWith([sources[0]]);
  });
});

it("does not expose registered secrets used as flow identifiers", async () => {
  registerSecrets(["synthetic-sensitive-flow-id"]);
  const service = management([
    { id: "synthetic-sensitive-flow-id", type: "tab" },
    {
      id: "a",
      type: "function",
      name: "work",
      z: "synthetic-sensitive-flow-id",
    },
  ]);
  expect((await service.resolveLogSources(sources)).available).toBe(false);
});
it("requires configured settings PIN on the actual log route", async () => {
  const app = await createApp({ env: { NOVA_ADMIN_PIN: "fixture-pin" } });
  try {
    const logs = vi
      .spyOn(app.app.get(StackControlService), "nodeRedLogs")
      .mockResolvedValue({
        available: true,
        entries: [],
        limited: true,
        truncated: false,
      });
    expect(
      (
        await app.api
          .get("/api/settings/stack-control/node-red/logs")
          .set(ADMIN)
      ).status,
    ).toBe(401);
    expect(logs).not.toHaveBeenCalled();
    const response = await app.api
      .get("/api/settings/stack-control/node-red/logs")
      .set({ ...ADMIN, "x-nova-pin": "fixture-pin" });
    expect(response.status).toBe(200);
    expect(response.body.entries).toEqual([]);
    expect(logs).toHaveBeenCalledOnce();
  } finally {
    await app.app.close();
  }
});
