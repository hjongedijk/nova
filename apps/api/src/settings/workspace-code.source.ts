import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import path from "node:path";
import {
  containsCodeSecret,
  untrustedCodeText,
} from "../core/security/code-content.js";
import { StackControlService } from "./stack-control.service.js";
import { WorkspaceCodeService } from "./workspace-code.service.js";
import { WorkspaceGitMcp } from "./workspace-git-mcp.service.js";
import { ToolSourceProvider, schema, text } from "../tools/tool.types.js";
import type {
  ToolCall,
  ToolDefinition,
  ToolPlan,
  ToolResult,
  ToolSource,
} from "../tools/tool.types.js";

const codeText = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const SELF_TEST_MAX_BYTES = 6000;
const SELF_TEST_TTL = 60_000;
const SELF_TEST_RUNNER =
  'const fs=require("node:fs"),{spawnSync}=require("node:child_process");const draft=process.argv[1],test=JSON.parse(process.argv[2]),source=process.argv.slice(3).join("");fs.writeFileSync(draft,Buffer.from(source,"base64"));try{const args=test.slice(1).map(a=>a==="{{draft}}"?draft:a);const r=spawnSync(test[0],args,{cwd:"/workspace",encoding:"utf8",timeout:25000,maxBuffer:32768});process.stdout.write((r.stdout||"")+(r.stderr||""));if(r.error)process.stderr.write(r.error.message);process.exit(r.status??1)}finally{try{fs.unlinkSync(draft)}catch{}}';

type SelfTestCandidate = {
  sessionId: string;
  projectId: string;
  path: string;
  testCommand: string[];
  tested: boolean;
  expiresAt: number;
};

@ToolSourceProvider()
@Injectable()
export class WorkspaceCodeSource implements ToolSource {
  readonly source = "code";
  private readonly selfTests = new Map<string, SelfTestCandidate>();

  constructor(
    private readonly code: WorkspaceCodeService,
    private readonly stack: StackControlService,
    private readonly git: WorkspaceGitMcp,
  ) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "code_projects",
        description: "List NOVA workspace projects.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "code_file_tree",
        description: "List files in the active project.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "code_latest_run",
        description: "Read the latest sandbox test output.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "code_file_read",
        description:
          "Read a bounded text file from the active workspace project.",
        parameters: schema({ path: text(500) }),
        risk: "READ_ONLY",
      },
      {
        name: "code_search",
        description: "Search text in files of the active workspace project.",
        parameters: schema({ query: text(200) }),
        risk: "READ_ONLY",
      },
      {
        name: "code_file_write",
        description:
          "Propose a text file change in the active project. Every write needs fresh approval.",
        parameters: schema(
          { path: text(500), content: codeText(262144), draftId: text(64) },
          [],
        ),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
      {
        name: "code_file_diff",
        description: "Show a pending workspace file change diff.",
        parameters: schema({ draftId: text(64) }),
        risk: "READ_ONLY",
      },
      {
        name: "code_file_delete",
        description:
          "Delete a text file from the active project. Dangerous and always requires fresh approval.",
        parameters: schema({ path: text(500) }),
        risk: "DANGEROUS",
        allowStandingApproval: false,
      },
      {
        name: "code_run_tests",
        description:
          "Run a test command in the isolated, network-disabled project sandbox. Always requires fresh approval.",
        parameters: schema(
          {
            command: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: codeText(1024),
            },
            draftId: text(64),
          },
          [],
        ),
        risk: "DANGEROUS",
        timeoutMs: 60000,
        allowStandingApproval: false,
      },
      {
        name: "code_git_init",
        description:
          "Initialize Git in the active project. Always requires fresh approval.",
        parameters: schema(),
        risk: "DANGEROUS",
        timeoutMs: 60000,
        allowStandingApproval: false,
      },
      {
        name: "code_git_status",
        description: "Read Git working tree status in the active project.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_diff_unstaged",
        description: "Read unstaged Git changes in the active project.",
        parameters: schema(
          { context_lines: { type: "integer", minimum: 0, maximum: 10 } },
          [],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_diff_staged",
        description: "Read staged Git changes in the active project.",
        parameters: schema(
          { context_lines: { type: "integer", minimum: 0, maximum: 10 } },
          [],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_diff",
        description: "Compare active project with a Git revision.",
        parameters: schema({
          target: text(128),
          context_lines: { type: "integer", minimum: 0, maximum: 10 },
        }),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_log",
        description: "Read recent Git history in the active project.",
        parameters: schema(
          { max_count: { type: "integer", minimum: 1, maximum: 50 } },
          [],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_show",
        description: "Read a Git revision in the active project.",
        parameters: schema({ revision: text(128) }),
        risk: "READ_ONLY",
      },
      {
        name: "code_git_branch",
        description: "List branches in the active project.",
        parameters: schema({
          branch_type: { type: "string", enum: ["local", "remote", "all"] },
        }),
        risk: "READ_ONLY",
      },
      {
        name: "code_self_test",
        description:
          "Test a small proposed script in the isolated sandbox before saving it. Requires fresh approval to run.",
        parameters: schema(
          {
            path: text(500),
            content: codeText(SELF_TEST_MAX_BYTES),
            testCommand: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: codeText(256),
            },
            draftId: text(64),
            projectId: text(64),
            diffPreview: text(4000),
          },
          [],
        ),
        risk: "DANGEROUS",
        timeoutMs: 60000,
        allowStandingApproval: false,
      },
      {
        name: "code_self_save",
        description:
          "Save a successfully sandbox-tested script proposal. Shows its diff and always needs fresh approval.",
        parameters: schema({ draftId: text(64) }),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
    ];
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolPlan> {
    if (name === "code_self_test") {
      let draftId: string;
      let candidate: SelfTestCandidate;
      if (typeof args.draftId === "string") {
        const existing = this.selfTests.get(args.draftId);
        if (
          !existing ||
          existing.expiresAt <= Date.now() ||
          existing.sessionId !== call.sessionId ||
          args.projectId !== existing.projectId ||
          JSON.stringify(args.testCommand) !==
            JSON.stringify(existing.testCommand)
        )
          throw new Error("Testvoorstel is verlopen of gewijzigd.");
        draftId = args.draftId;
        candidate = existing;
      } else {
        if (
          typeof args.content !== "string" ||
          Buffer.byteLength(args.content) > SELF_TEST_MAX_BYTES ||
          !Array.isArray(args.testCommand) ||
          !args.testCommand.every(
            (part) => typeof part === "string" && part.length <= 256,
          ) ||
          args.testCommand.filter((part) => part === "{{draft}}").length !==
            1 ||
          args.testCommand.some(
            (part) =>
              typeof part === "string" &&
              part !== "{{draft}}" &&
              part.includes("{{draft}}"),
          )
        )
          throw new Error("Ongeldig script- of testvoorstel.");
        const proposal = this.code.proposeWrite(
          { path: args.path, content: args.content },
          call.sessionId,
        );
        draftId = proposal.draft.id;
        candidate = {
          sessionId: call.sessionId,
          projectId: this.code.activeProjectId(),
          path: proposal.draft.path,
          testCommand: args.testCommand as string[],
          tested: false,
          expiresAt: Date.now() + SELF_TEST_TTL,
        };
        for (const [id, pending] of this.selfTests)
          if (pending.expiresAt <= Date.now()) this.selfTests.delete(id);
        if (this.selfTests.size >= 50) {
          this.code.discardDraft(draftId, call.sessionId);
          throw new Error("Er staan te veel scriptvoorstellen open.");
        }
        this.selfTests.set(draftId, candidate);
      }
      const preview = this.code
        .diffWrite(draftId, call.sessionId)
        .diff.slice(0, 4000);
      return {
        args: {
          draftId,
          projectId: candidate.projectId,
          path: candidate.path,
          testCommand: candidate.testCommand,
          diffPreview: preview,
        },
        risk: "DANGEROUS",
      };
    }
    if (name === "code_self_save") {
      const candidate = this.selfTests.get(String(args.draftId));
      if (
        !candidate ||
        !candidate.tested ||
        candidate.expiresAt <= Date.now() ||
        candidate.sessionId !== call.sessionId ||
        candidate.projectId !== this.code.activeProjectId()
      )
        throw new Error("Test het voorstel eerst opnieuw in de sandbox.");
      return {
        args: {
          draftId: args.draftId as string,
          projectId: candidate.projectId,
          path: candidate.path,
          diffPreview: this.code
            .diffWrite(args.draftId, call.sessionId)
            .diff.slice(0, 4000),
        },
        risk: "CONFIRM",
      };
    }
    if (name === "code_file_write") {
      const proposal = this.code.proposeWrite(args, call.sessionId);
      const preview = this.code
        .diffWrite(proposal.draft.id, call.sessionId)
        .diff.slice(0, 4000);
      return {
        args: {
          path: proposal.draft.path,
          draftId: proposal.draft.id,
          diffPreview: preview,
        },
        risk: "CONFIRM",
        data: proposal,
      };
    }
    if (name === "code_file_delete") {
      const prepared = this.code.prepareDelete(args.path);
      return { args: prepared, risk: "DANGEROUS" };
    }
    if (name === "code_run_tests") {
      const proposal = this.code.proposeRun(
        args.command,
        args.draftId,
        call.sessionId,
      );
      return {
        args: {
          draftId: proposal.draft.id,
          projectId: proposal.draft.projectId,
          command: proposal.draft.command,
        },
        risk: "DANGEROUS",
        data: proposal,
      };
    }
    if (name === "code_git_init") {
      const project = this.code
        .listProjects()
        .projects.find((item) => item.id === this.code.activeProjectId());
      if (!project) throw new Error("Open eerst een codeproject.");
      return { args: { projectId: project.id }, risk: "DANGEROUS" };
    }
    return { args, risk: "READ_ONLY" };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall & { plan?: ToolPlan },
  ): Promise<ToolResult> {
    if (name === "code_self_test") {
      const candidate = this.selfTests.get(String(args.draftId));
      if (
        !candidate ||
        candidate.sessionId !== call.sessionId ||
        candidate.projectId !== args.projectId ||
        candidate.expiresAt <= Date.now()
      )
        return {
          ok: false,
          error: "Testvoorstel is verlopen; maak het opnieuw.",
        };
      const draft = this.code.writeDraft(args.draftId, call.sessionId);
      const source = Buffer.from(draft.content, "utf8").toString("base64");
      const chunks = source.match(/.{1,700}/g) ?? [""];
      const extension = path.extname(draft.path) || ".js";
      const stagedPath = `/tmp/nova-proposal-${crypto.randomUUID()}${extension}`;
      const command = [
        "node",
        "-e",
        SELF_TEST_RUNNER,
        stagedPath,
        JSON.stringify(candidate.testCommand),
        ...chunks,
      ];
      try {
        const output = await this.stack.runCode(draft.projectId, command);
        if (containsCodeSecret(output.output)) {
          this.selfTests.delete(draft.id);
          this.code.discardDraft(draft.id, call.sessionId);
          return {
            ok: false,
            error: "Testuitvoer kan een geheim bevatten; uitvoer verborgen.",
          };
        }
        candidate.tested = output.ok;
        if (!output.ok) {
          this.selfTests.delete(draft.id);
          this.code.discardDraft(draft.id, call.sessionId);
        }
        return {
          ok: output.ok,
          result: {
            tested: true,
            passed: output.ok,
            path: draft.path,
            output: untrustedCodeText("sandbox test output", output.output),
            ...(output.ok ? { saveDraftId: draft.id } : {}),
          },
          verified: true,
        };
      } catch {
        this.selfTests.delete(draft.id);
        this.code.discardDraft(draft.id, call.sessionId);
        return {
          ok: false,
          error: "De script-test in de sandbox is niet gelukt.",
        };
      }
    }
    if (name === "code_self_save") {
      const candidate = this.selfTests.get(String(args.draftId));
      if (
        !candidate ||
        !candidate.tested ||
        candidate.sessionId !== call.sessionId ||
        candidate.projectId !== args.projectId
      )
        return {
          ok: false,
          error: "Test het voorstel opnieuw voordat je het opslaat.",
        };
      const saved = this.code.applyWrite(args.draftId, call.sessionId);
      this.selfTests.delete(String(args.draftId));
      return { ok: true, result: saved, verified: true };
    }
    if (name === "code_projects") {
      const projects = this.code.listProjects();
      return {
        ok: true,
        result: {
          ...projects,
          projects: projects.projects
            .filter((project) => !containsCodeSecret(project.name))
            .map((project) => ({
              ...project,
              name: untrustedCodeText("project name", project.name),
            })),
        },
      };
    }
    if (name === "code_file_tree") {
      const tree = this.code.tree();
      return {
        ok: true,
        result: {
          ...tree,
          files: tree.files
            .filter((file) => !containsCodeSecret(file.path))
            .map((file) => ({
              ...file,
              path: untrustedCodeText(file.path, file.path),
            })),
        },
      };
    }
    if (name === "code_latest_run") {
      const latest = this.code.latestRunReport();
      return {
        ok: true,
        result: latest
          ? {
              ...latest,
              output: untrustedCodeText("test output", latest.output),
            }
          : null,
      };
    }
    if (name === "code_file_read")
      return { ok: true, result: this.code.read(args.path) };
    if (name === "code_search")
      return { ok: true, result: this.code.search(args.query) };
    if (name === "code_file_diff")
      return {
        ok: true,
        result: this.code.diffWrite(args.draftId, call.sessionId),
      };
    if (name === "code_file_write")
      return {
        ok: true,
        result: this.code.applyWrite(args.draftId, call.sessionId),
        verified: true,
      };
    if (name === "code_file_delete")
      return {
        ok: true,
        result: this.code.deleteFile(
          args as { projectId: string; path: string; baseHash: string },
        ),
        verified: true,
      };
    if (name === "code_run_tests") {
      const draft = this.code.runDraft(args.draftId, call.sessionId);
      try {
        if (draft.projectId !== args.projectId)
          return {
            ok: false,
            error: "Project changed; prepare a new test run.",
          };
        const output = await this.stack.runCode(draft.projectId, draft.command);
        if (containsCodeSecret(output.output))
          return {
            ok: false,
            error: "Test output may contain a secret; output withheld.",
          };
        this.code.rememberRun({
          projectId: draft.projectId,
          command: draft.command,
          output: output.output,
          exitCode: output.exitCode,
          durationMs: output.durationMs,
        });
        return {
          ok: output.ok,
          result: {
            exitCode: output.exitCode,
            durationMs: output.durationMs,
            output: untrustedCodeText("test output", output.output),
          },
          verified: true,
        };
      } finally {
        this.code.finishRun(draft.id);
      }
    }
    if (name === "code_git_init") {
      if (
        typeof args.projectId !== "string" ||
        args.projectId !== this.code.activeProjectId()
      )
        return {
          ok: false,
          error: "Project changed; prepare Git initialization again.",
        };
      const initialized = await this.stack.runCode(args.projectId, [
        "git",
        "init",
      ]);
      if (!initialized.ok)
        return { ok: false, error: "Git could not initialize this project." };
      const output = await this.git.call(args.projectId, "git_status", {});
      if (containsCodeSecret(output))
        return {
          ok: false,
          error: "Git output may contain a secret; output withheld.",
        };
      return {
        ok: true,
        result: { output: untrustedCodeText("Git status", output) },
        verified: true,
      };
    }
    if (name.startsWith("code_git_")) {
      const tool = name.slice("code_".length);
      const projectId = this.code.activeProjectId();
      const safeArgs = { ...args };
      delete safeArgs.projectId;
      try {
        const output = await this.git.call(projectId, tool, safeArgs);
        if (containsCodeSecret(output))
          return {
            ok: false,
            error: "Git output may contain a secret; output withheld.",
          };
        return {
          ok: true,
          result: { output: untrustedCodeText("Git output", output) },
        };
      } catch {
        return {
          ok: false,
          error: "Git is unavailable; initialize the active project or retry.",
        };
      }
    }
    return { ok: false, error: "Unknown code tool" };
  }
}
