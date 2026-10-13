import { Injectable } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { WorkspaceProjects } from "./workspace-projects.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SandboxMcpTransport } from "../integrations/mcp/sandbox-transport.js";

const ALLOWED_TOOLS = new Set([
  "git_status",
  "git_diff_unstaged",
  "git_diff_staged",
  "git_diff",
  "git_log",
  "git_show",
  "git_branch",
]);
const MAX_RESULT_BYTES = 20_000;
const TIMEOUT_MS = 15_000;
const REVIEWED_PYTHON = "/opt/git-mcp/bin/python";

/** Starts the pinned Git MCP server for one project, with its repository root fixed at launch. */
@Injectable()
export class WorkspaceGitMcp {
  constructor(
    private readonly projects: WorkspaceProjects,
    private readonly config: NovaConfig,
  ) {}

  async call(
    projectId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!ALLOWED_TOOLS.has(tool))
      throw new ValidationError(["Deze Git MCP-tool staat niet toe."]);
    const project = this.projects.activeProject();
    if (project.id !== projectId)
      throw new ValidationError(["Het actieve project is gewijzigd."]);
    const repoPath = this.projects.projectDirectory(projectId);
    const client = new Client({ name: "nova-workspace-git", version: "1.0.0" });
    const isolated = process.env.NODE_ENV !== "test";
    const transport = isolated
      ? new SandboxMcpTransport(
          this.config.stackControlUrl,
          this.config.stackControlToken,
          "workspace-git",
          projectId,
        )
      : new StdioClientTransport({
          command: REVIEWED_PYTHON,
          args: ["-m", "mcp_server_git", "--repository", repoPath],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: "/tmp",
            PYTHONNOUSERSITE: "1",
            PYTHONDONTWRITEBYTECODE: "1",
          },
          stderr: "ignore",
        });
    try {
      await client.connect(transport, { timeout: TIMEOUT_MS });
      const result = await client.callTool(
        {
          name: tool,
          arguments: {
            ...args,
            repo_path: isolated ? `/data/workspace/${projectId}` : repoPath,
          },
        },
        undefined,
        { timeout: TIMEOUT_MS },
      );
      if (result.isError) throw new Error("Git MCP returned an error");
      const content = result.content as Array<{ type: string; text?: string }>;
      const output = (content ?? [])
        .map((part) =>
          part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
        )
        .join("\n");
      if (Buffer.byteLength(output) > MAX_RESULT_BYTES)
        return `${Buffer.from(output).subarray(0, MAX_RESULT_BYTES).toString("utf8")}\n[uitvoer afgekapt]`;
      return output;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new Error(
        "Git MCP is niet beschikbaar of gaf geen veilige uitvoer.",
        { cause: error },
      );
    } finally {
      await client.close().catch(() => {});
    }
  }
}
