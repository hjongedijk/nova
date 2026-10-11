import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { WorkspaceProjects } from "../../src/settings/workspace-projects.service.js";

describe("workspace projects", () => {
  let dataDir: string;
  let oldData: string | undefined;
  let service: WorkspaceProjects;
  let audit: AuditService;
  let confirmations: ConfirmationsService;
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-workspace-"));
    oldData = process.env.NOVA_DATA_DIR;
    process.env.NOVA_DATA_DIR = dataDir;
    record = vi.fn((entry: AuditRecord) => ({
      ...entry,
      id: "audit",
      timestamp: "now",
    }));
    audit = { record } as unknown as AuditService;
    confirmations = new ConfirmationsService(audit);
    confirmations.now = () => 1000;
    service = new WorkspaceProjects(new NovaConfig(), confirmations, audit);
  });

  afterEach(() => {
    if (oldData === undefined) delete process.env.NOVA_DATA_DIR;
    else process.env.NOVA_DATA_DIR = oldData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a bounded project directory and selects it without exposing its contents", () => {
    const created = service.create({ name: "Mijn Eerste Project" });
    expect(created).toMatchObject({
      activeId: "mijn-eerste-project",
      projects: [{ id: "mijn-eerste-project", name: "Mijn Eerste Project" }],
    });
    const directory = path.join(dataDir, "workspace", "mijn-eerste-project");
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(directory, "private.txt"), "private");
    expect(JSON.stringify(service.list())).not.toContain("private.txt");
    expect(service.select({ id: "mijn-eerste-project" }).activeId).toBe(
      "mijn-eerste-project",
    );
    expect(
      new WorkspaceProjects(new NovaConfig(), confirmations, audit).list(),
    ).toMatchObject({
      activeId: "mijn-eerste-project",
      projects: [{ id: "mijn-eerste-project" }],
    });
  });

  it("rejects path-like names, extra fields, duplicate slugs and unknown projects", () => {
    expect(() => service.create({ name: "../../secret" })).toThrow();
    expect(() => service.create({ name: "valid", path: "/tmp" })).toThrow();
    service.create({ name: "valid" });
    expect(() => service.create({ name: "VALID" })).toThrow();
    expect(() => service.select({ id: "../../secret" })).toThrow();
    expect(() => service.select({ id: "missing" })).toThrow();
  });

  it("refuses a workspace root that is a symlink", () => {
    const root = path.join(dataDir, "workspace");
    fs.symlinkSync(os.tmpdir(), root, "dir");
    expect(() => service.list()).toThrow("real directory");
  });

  it("refuses a catalog file that is a symlink", () => {
    const root = path.join(dataDir, "workspace");
    fs.mkdirSync(root);
    const external = path.join(dataDir, "outside.json");
    fs.writeFileSync(external, JSON.stringify({ version: 1, projects: [] }));
    fs.symlinkSync(external, path.join(root, "projects.json"));
    expect(() => service.list()).toThrow("regular file");
  });

  it("records project selection and restores only the latest selection with confirmation", () => {
    const first = service.create({ name: "first" });
    service.create({ name: "second" });
    service.select({ id: "first" });
    const second = service.select({ id: "second" });
    const historyPath = path.join(
      dataDir,
      "workspace",
      "project-selection-history.json",
    );
    expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
    expect(service.history().revisions).toHaveLength(4);
    const revision = service.history().revisions[0]!;
    const prepared = service.prepareRollback(revision.id);
    expect(prepared).toMatchObject({
      ok: true,
      fromName: "second",
      toName: "first",
    });
    expect(prepared.action?.risk).toBe("DANGEROUS");
    expect(service.list().activeId).toBe(second.activeId);
    const action = prepared.action!;
    expect(
      service.confirmRollback(action.sessionId, action.confirmationId, true),
    ).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(service.list().activeId).toBe(first.activeId);
    expect(service.history().revisions).toHaveLength(5);
    expect(record.mock.calls.map(([entry]) => entry.tool)).toContain(
      "workspace_project_selection_rollback",
    );
  });

  it("undoes creation of a still-empty project and restores the prior project", () => {
    service.create({ name: "first" });
    const second = service.create({ name: "second" });
    const secondDir = path.join(dataDir, "workspace", "second");
    const revision = service.history().revisions[0]!;
    expect(revision).toMatchObject({ kind: "created", projectId: "second" });
    const prepared = service.prepareRollback(revision.id);
    expect(prepared).toMatchObject({
      ok: true,
      fromName: "second",
      toName: "Project verwijderen",
    });
    expect(prepared.action?.risk).toBe("DANGEROUS");
    const result = service.confirmRollback(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(fs.existsSync(secondDir)).toBe(false);
    expect(service.list()).toMatchObject({
      activeId: "first",
      projects: [{ id: "first" }],
    });
    expect(second.activeId).toBe("second");
  });

  it("refuses to undo project creation when files exist before or after preparation", () => {
    service.create({ name: "first" });
    const second = service.create({ name: "second" });
    const secondDir = path.join(dataDir, "workspace", second.activeId!);
    const revision = service.history().revisions[0]!;
    fs.writeFileSync(path.join(secondDir, "keep.txt"), "keep me");
    expect(service.prepareRollback(revision.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("bevat bestanden"),
    });
    fs.unlinkSync(path.join(secondDir, "keep.txt"));
    const prepared = service.prepareRollback(revision.id);
    expect(prepared.action).toBeDefined();
    fs.writeFileSync(path.join(secondDir, "late.txt"), "keep me too");
    const result = service.confirmRollback(
      prepared.action!.sessionId,
      prepared.action!.confirmationId,
      true,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("bevat bestanden"),
    });
    expect(fs.readFileSync(path.join(secondDir, "late.txt"), "utf8")).toBe(
      "keep me too",
    );
    expect(service.list().activeId).toBe("second");
  });

  it("refuses an older creation revision and leaves a cancelled creation untouched", () => {
    service.create({ name: "first" });
    const oldRevision = service.history().revisions[0]!;
    service.create({ name: "second" });
    expect(service.prepareRollback(oldRevision.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("nieuwste"),
    });

    const latest = service.history().revisions[0]!;
    const prepared = service.prepareRollback(latest.id);
    expect(prepared.action).toBeDefined();
    expect(
      service.confirmRollback(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        false,
      ),
    ).toMatchObject({ ok: true });
    expect(
      fs.statSync(path.join(dataDir, "workspace", "second")).isDirectory(),
    ).toBe(true);
    expect(service.list().activeId).toBe("second");
  });

  it("rejects confirmation after the project catalog changes", () => {
    service.create({ name: "first" });
    const created = service.create({ name: "second" });
    const prepared = service.prepareRollback(
      service.history().revisions[0]!.id,
    );
    expect(prepared.action).toBeDefined();
    service.select({ id: "first" });
    expect(
      service.confirmRollback(
        prepared.action!.sessionId,
        prepared.action!.confirmationId,
        true,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("intussen gewijzigd"),
    });
    expect(
      fs
        .statSync(path.join(dataDir, "workspace", created.activeId!))
        .isDirectory(),
    ).toBe(true);
    expect(service.list().activeId).toBe("first");
  });

  it("rejects an old project-selection rollback after active project changes", () => {
    service.create({ name: "first" });
    service.create({ name: "second" });
    const prepared = service.prepareRollback(
      service.history().revisions[0]!.id,
    );
    if (!prepared.action) throw new Error("Missing confirmation");
    service.select({ id: "first" });
    expect(
      service.confirmRollback(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("intussen gewijzigd"),
    });
    expect(service.list().activeId).toBe("first");
  });

  it("revalidates the rollback destination directory before restoring it", () => {
    service.create({ name: "first" });
    service.create({ name: "second" });
    service.select({ id: "first" });
    service.select({ id: "second" });
    const firstDir = path.join(dataDir, "workspace", "first");
    const prepared = service.prepareRollback(
      service.history().revisions[0]!.id,
    );
    if (!prepared.action) throw new Error("Missing confirmation");
    fs.rmSync(firstDir, { recursive: true });
    fs.symlinkSync(os.tmpdir(), firstDir, "dir");

    expect(
      service.confirmRollback(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        true,
      ),
    ).toMatchObject({ ok: false, error: "De vorige projectmap is ongeldig." });
    expect(service.list().activeId).toBe("second");
  });

  it("does not prepare rollback to a missing project directory", () => {
    service.create({ name: "first" });
    service.create({ name: "second" });
    service.select({ id: "first" });
    service.select({ id: "second" });
    fs.rmSync(path.join(dataDir, "workspace", "first"), {
      recursive: true,
    });

    expect(
      service.prepareRollback(service.history().revisions[0]!.id),
    ).toMatchObject({ ok: false, error: "De vorige projectmap is ongeldig." });
  });
});
