import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SandboxMcpTransport } from "../../src/integrations/mcp/sandbox-transport.js";
import { WorkspaceGitMcp } from "../../src/settings/workspace-git-mcp.service.js";
import type { WorkspaceProjects } from "../../src/settings/workspace-projects.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("workspace Git MCP binding", () => {
  it("refuses to launch after the active project changes", async () => {
    const projects = {
      activeProject: vi.fn(() => ({ id: "different-project" })),
      projectDirectory: vi.fn(),
    } as unknown as WorkspaceProjects;
    const git = new WorkspaceGitMcp(projects, {} as NovaConfig);

    await expect(git.call("project", "git_status", {})).rejects.toThrow(
      "Het actieve project is gewijzigd.",
    );
    expect(projects.activeProject).toHaveBeenCalledOnce();
    expect(projects.projectDirectory).not.toHaveBeenCalled();
  });

  it("uses the isolated broker in production and fixes tool arguments to the mounted project", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const connect = vi
      .spyOn(Client.prototype, "connect")
      .mockResolvedValue(undefined);
    const call = vi
      .spyOn(Client.prototype, "callTool")
      .mockResolvedValue({ content: [] });
    const projects = {
      activeProject: () => ({ id: "project-a" }),
      projectDirectory: () => "/private/local-workspace/project-a",
    } as unknown as WorkspaceProjects;
    const config = {
      stackControlUrl: "http://broker:8090",
      stackControlToken: "a".repeat(64),
    } as NovaConfig;
    expect(
      await new WorkspaceGitMcp(projects, config).call(
        "project-a",
        "git_status",
        { repo_path: "/another-project" },
      ),
    ).toBe("");
    expect(connect.mock.calls[0]?.[0]).toBeInstanceOf(SandboxMcpTransport);
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      arguments: { repo_path: "/data/workspace/project-a" },
    });
  });
});
