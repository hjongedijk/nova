import { describe, expect, it, vi } from "vitest";
import { WorkspaceGitMcp } from "../../src/settings/workspace-git-mcp.service.js";
import type { WorkspaceProjects } from "../../src/settings/workspace-projects.service.js";

describe("workspace Git MCP binding", () => {
  it("refuses to launch after the active project changes", async () => {
    const projects = {
      activeProject: vi.fn(() => ({ id: "different-project" })),
      projectDirectory: vi.fn(),
    } as unknown as WorkspaceProjects;
    const git = new WorkspaceGitMcp(projects);

    await expect(git.call("project", "git_status", {})).rejects.toThrow(
      "Het actieve project is gewijzigd.",
    );
    expect(projects.activeProject).toHaveBeenCalledOnce();
    expect(projects.projectDirectory).not.toHaveBeenCalled();
  });
});
