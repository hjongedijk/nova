import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  containsCodeSecret,
  untrustedCodeText,
} from "../core/security/code-content.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { WorkspaceProjects } from "./workspace-projects.service.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_RESULTS = 50;
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_DRAFTS = 50;
const DRAFT_TTL = 60_000;
const OMIT_DIRS = new Set([
  ".git",
  ".nova",
  "node_modules",
  "dist",
  "build",
  ".svelte-kit",
  ".cache",
  "coverage",
]);

type Draft = {
  id: string;
  projectId: string;
  sessionId: string;
  path: string;
  baseHash: string | null;
  newHash: string;
  oldText: string;
  newText: string;
  expiresAt: number;
};

type RunDraft = {
  id: string;
  projectId: string;
  sessionId: string;
  command: string[];
  expiresAt: number;
};

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function textFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
    throw new ValidationError(["Bestand is geen tekstbestand of is te groot."]);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0))
    throw new ValidationError(["Binaire bestanden worden niet gelezen."]);
  const content = bytes.toString("utf8");
  if (containsCodeSecret(content))
    throw new ValidationError(["Bestand mogelijk met geheimen geblokkeerd."]);
  return content;
}

function pathParts(value: unknown): string[] {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  )
    throw new ValidationError(["Ongeldig relatief bestandspad."]);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new ValidationError(["Ongeldig relatief bestandspad."]);
  return parts;
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new ValidationError(["Pad valt buiten het actieve project."]);
}

/** Workspace file operations stay under one active project and never follow symlinks. */
@Injectable()
export class WorkspaceCodeService {
  private readonly drafts = new Map<string, Draft | RunDraft>();
  private latestRun: {
    projectId: string;
    command: string[];
    output: string;
    exitCode: number | null;
    durationMs: number;
  } | null = null;

  constructor(private readonly projects: WorkspaceProjects) {}

  activeProjectId(): string {
    return this.projects.activeProject().id;
  }

  private active() {
    const project = this.projects.activeProject();
    return { project, root: this.projects.projectDirectory(project.id) };
  }

  private resolve(
    relativePath: unknown,
    createParents = false,
    projectId?: string,
  ): {
    root: string;
    target: string;
    rel: string;
    exists: boolean;
  } {
    const project = projectId
      ? this.projects.list().projects.find((item) => item.id === projectId)
      : this.projects.activeProject();
    if (!project) throw new ValidationError(["Codeproject bestaat niet meer."]);
    const root = this.projects.projectDirectory(project.id);
    const parts = pathParts(relativePath);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const next = path.join(cursor, part);
      assertContained(root, next);
      try {
        const stat = fs.lstatSync(next);
        if (stat.isSymbolicLink())
          throw new ValidationError(["Symlinks worden niet geopend."]);
        if (i < parts.length - 1 && !stat.isDirectory())
          throw new ValidationError(["Padcomponent is geen map."]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (createParents && i < parts.length - 1) {
          fs.mkdirSync(next, { mode: 0o700 });
          cursor = next;
          continue;
        }
      }
      cursor = next;
    }
    const target = path.resolve(root, ...parts);
    assertContained(root, target);
    let exists = false;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink())
        throw new ValidationError(["Symlinks worden niet geopend."]);
      if (!stat.isFile()) throw new ValidationError(["Doel is geen bestand."]);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { root, target, rel: `${project.id}/${parts.join("/")}`, exists };
  }

  listProjects() {
    return this.projects.list();
  }

  tree() {
    const { project, root } = this.active();
    const files: { path: string; bytes: number }[] = [];
    const pending = [root];
    let scanned = 0;
    while (pending.length && scanned < 2000 && files.length < 1000) {
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!OMIT_DIRS.has(entry.name))
            pending.push(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        scanned++;
        const file = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) continue;
          if (stat.size > MAX_FILE_BYTES) continue;
          const fd = fs.openSync(file, "r");
          let sample: Buffer;
          try {
            sample = Buffer.alloc(Math.min(stat.size, 8192));
            fs.readSync(fd, sample, 0, sample.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          if (sample.includes(0)) continue;
          files.push({
            path: path.relative(root, file).split(path.sep).join("/"),
            bytes: stat.size,
          });
        } catch {
          /* A concurrently replaced file is omitted. */
        }
        if (scanned >= 2000 || files.length >= 1000) break;
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      projectId: project.id,
      files,
      truncated: pending.length > 0 || scanned >= 2000 || files.length >= 1000,
    };
  }

  latestRunReport() {
    const run = this.latestRun;
    if (!run || run.projectId !== this.projects.activeProject().id) return null;
    return { ...run, command: [...run.command] };
  }

  rememberRun(run: {
    projectId: string;
    command: string[];
    output: string;
    exitCode: number | null;
    durationMs: number;
  }) {
    if (
      Buffer.byteLength(run.output) > 32 * 1024 ||
      containsCodeSecret(run.output)
    )
      throw new ValidationError([
        "Testuitvoer bevat mogelijk een geheim en wordt niet bewaard.",
      ]);
    this.latestRun = { ...run, command: [...run.command] };
  }

  read(relativePath: unknown) {
    const resolved = this.resolve(relativePath);
    if (!resolved.exists) throw new ValidationError(["Bestand bestaat niet."]);
    const content = textFile(resolved.target);
    return {
      path: resolved.rel,
      bytes: Buffer.byteLength(content),
      sha256: hash(content),
      untrusted: true,
      content: untrustedCodeText(resolved.rel, content),
    };
  }

  search(query: unknown) {
    if (
      typeof query !== "string" ||
      query.trim().length < 1 ||
      query.length > 200
    )
      throw new ValidationError(["Zoekterm moet 1 tot 200 tekens bevatten."]);
    const { project, root } = this.active();
    const needle = query.toLocaleLowerCase("en-US");
    const results: { path: string; line: number; text: string }[] = [];
    const pending = [root];
    let scanned = 0;
    let scannedBytes = 0;
    let skippedSecrets = 0;
    while (
      pending.length &&
      scanned < MAX_SCAN_FILES &&
      scannedBytes < MAX_SCAN_BYTES &&
      results.length < MAX_RESULTS
    ) {
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!OMIT_DIRS.has(entry.name))
            pending.push(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        scanned++;
        const file = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(file);
          if (
            stat.size > MAX_FILE_BYTES ||
            scannedBytes + stat.size > MAX_SCAN_BYTES
          )
            continue;
          const bytes = fs.readFileSync(file);
          scannedBytes += bytes.byteLength;
          if (bytes.includes(0)) continue;
          const content = bytes.toString("utf8");
          if (containsCodeSecret(content)) {
            skippedSecrets++;
            continue;
          }
          const relative = path.relative(root, file).split(path.sep).join("/");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++)
            if (lines[i]!.toLocaleLowerCase("en-US").includes(needle))
              results.push({
                path: `${project.id}/${relative}`,
                line: i + 1,
                text: lines[i]!.slice(0, 500),
              });
        } catch {
          // Files can be replaced while the workspace is being inspected.
        }
        if (
          scanned >= MAX_SCAN_FILES ||
          scannedBytes >= MAX_SCAN_BYTES ||
          results.length >= MAX_RESULTS
        )
          break;
      }
    }
    return {
      results: results.map((item) => ({
        ...item,
        text: untrustedCodeText(item.path, item.text),
        untrusted: true,
      })),
      truncated:
        pending.length > 0 ||
        scanned >= MAX_SCAN_FILES ||
        scannedBytes >= MAX_SCAN_BYTES,
      filesScanned: scanned,
      secretFilesSkipped: skippedSecrets,
    };
  }

  private remember(draft: Draft | RunDraft): void {
    const now = Date.now();
    for (const [id, item] of this.drafts)
      if (item.expiresAt <= now) this.drafts.delete(id);
    if (this.drafts.size >= MAX_DRAFTS)
      throw new ValidationError([
        "Te veel code-acties wachten op bevestiging.",
      ]);
    this.drafts.set(draft.id, draft);
  }

  private getDraft<T extends Draft | RunDraft>(
    id: unknown,
    sessionId: string,
    kind: "write" | "run",
  ): T {
    const draft = typeof id === "string" ? this.drafts.get(id) : undefined;
    if (draft && draft.expiresAt <= Date.now()) this.drafts.delete(draft.id);
    if (
      !draft ||
      draft.expiresAt <= Date.now() ||
      draft.sessionId !== sessionId ||
      (kind === "write" ? !("newText" in draft) : !("command" in draft))
    ) {
      throw new ValidationError(["Codevoorstel is verlopen of ongeldig."]);
    }
    return draft as T;
  }

  writeDraft(id: unknown, sessionId: string) {
    const draft = this.getDraft<Draft>(id, sessionId, "write");
    return {
      id: draft.id,
      projectId: draft.projectId,
      path: draft.path,
      content: draft.newText,
    };
  }

  discardDraft(id: unknown, sessionId: string): void {
    const draft = this.getDraft<Draft>(id, sessionId, "write");
    this.drafts.delete(draft.id);
  }

  proposeWrite(
    input: { path?: unknown; content?: unknown; draftId?: unknown },
    sessionId: string,
  ) {
    if (input.draftId) {
      const draft = this.getDraft<Draft>(input.draftId, sessionId, "write");
      if (input.path !== draft.path)
        throw new ValidationError([
          "Codevoorstel is gewijzigd; vraag het opnieuw.",
        ]);
      return { draft, created: false };
    }
    if (
      typeof input.content !== "string" ||
      Buffer.byteLength(input.content) > MAX_WRITE_BYTES
    )
      throw new ValidationError([
        "Nieuwe bestandsinhoud moet maximaal 256 KiB zijn.",
      ]);
    if (containsCodeSecret(input.content))
      throw new ValidationError([
        "Bestandswijziging mogelijk met geheimen geblokkeerd.",
      ]);
    const resolved = this.resolve(input.path);
    const oldText = resolved.exists ? textFile(resolved.target) : "";
    const baseHash = resolved.exists ? hash(oldText) : null;
    const newHash = hash(input.content);
    const draft: Draft = {
      id: crypto.randomUUID(),
      projectId: this.projects.activeProject().id,
      sessionId,
      path: String(input.path),
      baseHash,
      newHash,
      oldText,
      newText: input.content,
      expiresAt: Date.now() + DRAFT_TTL,
    };
    this.remember(draft);
    return { draft, created: true };
  }

  diffWrite(draftId: unknown, sessionId: string) {
    const draft = this.getDraft<Draft>(draftId, sessionId, "write");
    const before = draft.oldText.split(/\r?\n/);
    const after = draft.newText.split(/\r?\n/);
    const lines = [
      `--- ${draft.path}`,
      `+++ ${draft.path}`,
      `@@ -1,${before.length} +1,${after.length} @@`,
      ...before.filter((line) => line.length).map((line) => `-${line}`),
      ...after.filter((line) => line.length).map((line) => `+${line}`),
    ];
    return {
      draftId: draft.id,
      path: `${draft.projectId}/${draft.path}`,
      baseHash: draft.baseHash,
      newHash: draft.newHash,
      diff: lines.join("\n").slice(0, 64 * 1024),
      expiresAt: draft.expiresAt,
      untrusted: true,
    };
  }

  applyWrite(draftId: unknown, sessionId: string) {
    const draft = this.getDraft<Draft>(draftId, sessionId, "write");
    if (this.projects.activeProject().id !== draft.projectId)
      throw new ValidationError([
        "Actief project is gewijzigd; vraag het bestand opnieuw aan.",
      ]);
    const resolved = this.resolve(draft.path, true, draft.projectId);
    const current = resolved.exists ? textFile(resolved.target) : null;
    if ((current === null ? null : hash(current)) !== draft.baseHash) {
      this.drafts.delete(draft.id);
      throw new ValidationError([
        "Bestand is intussen gewijzigd; maak een nieuw voorstel.",
      ]);
    }
    const temp = `${resolved.target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, draft.newText, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, resolved.target);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The rename already moved the temporary file.
      }
    }
    this.drafts.delete(draft.id);
    return {
      ok: true,
      path: `${draft.projectId}/${draft.path}`,
      bytes: Buffer.byteLength(draft.newText),
      sha256: draft.newHash,
      verified:
        hash(fs.readFileSync(resolved.target, "utf8")) === draft.newHash,
    };
  }

  prepareDelete(relativePath: unknown) {
    const resolved = this.resolve(relativePath);
    if (!resolved.exists) throw new ValidationError(["Bestand bestaat niet."]);
    const content = textFile(resolved.target);
    return {
      projectId: this.projects.activeProject().id,
      path: String(relativePath),
      baseHash: hash(content),
    };
  }

  deleteFile(input: { projectId: string; path: string; baseHash: string }) {
    if (this.projects.activeProject().id !== input.projectId)
      throw new ValidationError(["Het actieve project is gewijzigd."]);
    const resolved = this.resolve(input.path);
    if (!resolved.exists || hash(textFile(resolved.target)) !== input.baseHash)
      throw new ValidationError(["Bestand is gewijzigd; vraag het opnieuw."]);
    fs.unlinkSync(resolved.target);
    return {
      ok: true,
      path: `${input.projectId}/${input.path}`,
      verified: !fs.existsSync(resolved.target),
    };
  }

  proposeRun(command: unknown, draftId: unknown, sessionId: string) {
    if (draftId) {
      const draft = this.getDraft<RunDraft>(draftId, sessionId, "run");
      return { draft, created: false };
    }
    if (
      !Array.isArray(command) ||
      command.length < 1 ||
      command.length > 32 ||
      command.some(
        (part) =>
          typeof part !== "string" ||
          !part.length ||
          part.length > 1024 ||
          part.includes("\0"),
      )
    )
      throw new ValidationError(["Ongeldig testcommando."]);
    const serialized = JSON.stringify(command);
    if (containsCodeSecret(serialized))
      throw new ValidationError([
        "Testcommando mogelijk met geheimen geblokkeerd.",
      ]);
    const draft: RunDraft = {
      id: crypto.randomUUID(),
      projectId: this.projects.activeProject().id,
      sessionId,
      command,
      expiresAt: Date.now() + DRAFT_TTL,
    };
    this.remember(draft);
    return { draft, created: true };
  }

  runDraft(draftId: unknown, sessionId: string): RunDraft {
    return this.getDraft<RunDraft>(draftId, sessionId, "run");
  }

  finishRun(draftId: string): void {
    this.drafts.delete(draftId);
  }
}
