import { describe, expect, it } from "vitest";
import { McpStatusController } from "../../src/settings/mcp-status.controller.js";

describe("MCP worker status", () => {
  it("distinguishes running processes from protocol connections", async () => {
    const report = {
      servers: [
        { id: "filesystem", connected: true },
        { id: "context7", connected: false },
      ],
    };
    const controller = new McpStatusController(
      { status: () => report } as never,
      {} as never,
      {} as never,
      {
        status: async () => ({
          mcpWorkers: [
            { server: "filesystem", state: "running", workerCount: 1 },
            { server: "context7", state: "running", workerCount: 1 },
            { server: "workspace-git", state: "missing", workerCount: 0 },
          ],
        }),
      } as never,
    );
    expect(await controller.getServers()).toEqual({
      ...report,
      workers: [
        {
          server: "filesystem",
          state: "running",
          workerCount: 1,
          connected: true,
        },
        {
          server: "context7",
          state: "running",
          workerCount: 1,
          connected: false,
        },
        {
          server: "workspace-git",
          state: "missing",
          workerCount: 0,
          connected: null,
        },
      ],
    });
  });
  it("preserves connection reports when broker status is unavailable", async () => {
    const report = { servers: [] };
    const controller = new McpStatusController(
      { status: () => report } as never,
      {} as never,
      {} as never,
    );
    expect(await controller.getServers()).toEqual(report);
  });
});
