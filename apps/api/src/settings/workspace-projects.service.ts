import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import type {
  WorkspaceProjectSelectionHistory,
  WorkspaceProjectSelectionResult,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { AuditService } from "../core/audit/audit.service.js";

interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
}
interface Catalog {
  version: 1;
  activeId: string | null;
  projects: ProjectRecord[];
  historyWarning?: string;
}

const empty = (): Catalog => ({ version: 1, activeId: null, projects: [] });
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value);
const MAX_HISTORY = 20;
type SelectionRevision = {
  id: string;
  at: string;
  kind: "selection" | "created";
  projectId?: string;
  beforeId: string | null;
  afterId: string | null;
  beforeRevision: string;
  afterRevision: string;
};
const catalogDigest = (catalog: Catalog) =>
  crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

/** Project metadata only; this service never reads or writes files inside a project. */
@Injectable()
export class WorkspaceProjects {
  private readonly root: string;
  private readonly catalogFile: string;
  private readonly historyFile: string;
  private inFlight = false;

  constructor(
    config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.root = path.join(config.dataDir, "workspace");
    this.catalogFile = path.join(this.root, "projects.json");
    this.historyFile = path.join(this.root, "project-selection-history.json");
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Workspace root must be a real directory");
  }

  private read(): Catalog {
    this.ensureRoot();
    try {
      const fileStat = fs.lstatSync(this.catalogFile);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.size > 128 * 1024
      )
        throw new Error("Workspace catalog must be a regular file");
      const raw: unknown = JSON.parse(
        fs.readFileSync(this.catalogFile, "utf8"),
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        (raw as Catalog).version !== 1 ||
        !Array.isArray((raw as Catalog).projects) ||
        (raw as Catalog).projects.length > 256 ||
        !(
          (raw as Catalog).activeId === null ||
          validId((raw as Catalog).activeId)
        )
      )
        throw new Error("invalid catalog");
      const projects = (raw as Catalog).projects;
      if (
        projects.some(
          (item) =>
            !item ||
            !validId(item.id) ||
            typeof item.name !== "string" ||
            item.name.length < 1 ||
            item.name.length > 64 ||
            typeof item.createdAt !== "string" ||
            !Number.isFinite(Date.parse(item.createdAt)),
        ) ||
        new Set(projects.map((item) => item.id)).size !== projects.length
      )
        throw new Error("Workspace catalog entries are invalid");
      return {
        version: 1,
        activeId: projects.some((item) => item.id === (raw as Catalog).activeId)
          ? (raw as Catalog).activeId
          : null,
        projects,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      if (error instanceof SyntaxError)
        throw new Error("Workspace catalog is invalid", { cause: error });
      throw error;
    }
  }

  private write(catalog: Catalog): void {
    const temp = `${this.catalogFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(catalog, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, this.catalogFile);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The rename already moved the file.
      }
    }
  }

  private readHistory(): SelectionRevision[] {
    let raw: unknown;
    try {
      const stat = fs.lstatSync(this.historyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        throw new Error("invalid history file");
      raw = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ValidationError(["Projectgeschiedenis is niet leesbaar."]);
    }
    if (!Array.isArray(raw) || raw.length > MAX_HISTORY)
      throw new ValidationError(["Projectgeschiedenis is ongeldig."]);
    return raw.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(item.id) ||
        !(item.beforeId === null || validId(item.beforeId)) ||
        !(item.afterId === null || validId(item.afterId)) ||
        item.beforeId === item.afterId ||
        typeof item.at !== "string" ||
        !Number.isFinite(Date.parse(item.at)) ||
        typeof item.beforeRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.beforeRevision) ||
        typeof item.afterRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.afterRevision) ||
        (item.kind !== undefined &&
          item.kind !== "selection" &&
          item.kind !== "created") ||
        (item.kind === "created" && !validId(item.projectId))
      )
        throw new ValidationError(["Projectgeschiedenis is ongeldig."]);
      return {
        ...item,
        // Older history entries predate the explicit operation kind.
        kind: item.kind === "created" ? "created" : "selection",
        at: new Date(item.at).toISOString(),
      } as SelectionRevision;
    });
  }

  private appendHistory(before: Catalog, after: Catalog): string | undefined {
    const created = after.projects.find(
      (project) => !before.projects.some((item) => item.id === project.id),
    );
    if (!created && before.activeId === after.activeId) return;
    const entry: SelectionRevision = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: created ? "created" : "selection",
      ...(created ? { projectId: created.id } : {}),
      beforeId: before.activeId,
      afterId: after.activeId,
      beforeRevision: catalogDigest(before),
      afterRevision: catalogDigest(after),
    };
    const temp = `${this.historyFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temp,
        JSON.stringify([...this.readHistory(), entry].slice(-MAX_HISTORY)),
        { mode: 0o600, flag: "wx" },
      );
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.historyFile);
      const dir = fs.openSync(this.root, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
      return;
    } catch {
      return "Project geopend, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  history(): WorkspaceProjectSelectionHistory {
    const revisions = this.readHistory();
    return {
      revisions: revisions
        .slice(-20)
        .reverse()
        .map(({ id, at, kind, projectId, beforeId, afterId }) => ({
          id,
          at,
          kind,
          ...(projectId ? { projectId } : {}),
          beforeId,
          afterId,
        })),
      truncated: revisions.length === MAX_HISTORY,
    };
  }

  private projectDir(id: string): string {
    if (!validId(id)) throw new ValidationError(["Ongeldig project."]);
    return path.join(this.root, id);
  }

  private projectDirectoryIsEmpty(id: string): boolean {
    try {
      const directory = this.projectDir(id);
      const stat = fs.lstatSync(directory);
      return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        fs.readdirSync(directory).length === 0
      );
    } catch {
      return false;
    }
  }

  list(): Catalog {
    const catalog = this.read();
    return {
      ...catalog,
      projects: catalog.projects.filter((project) => {
        try {
          const stat = fs.lstatSync(this.projectDir(project.id));
          return stat.isDirectory() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      }),
    };
  }

  activeProject(): ProjectRecord {
    const catalog = this.list();
    const active = catalog.projects.find(
      (item) => item.id === catalog.activeId,
    );
    if (!active) throw new ValidationError(["Open eerst een codeproject."]);
    return active;
  }

  projectDirectory(id: string): string {
    const catalog = this.read();
    if (!catalog.projects.some((item) => item.id === id))
      throw new ValidationError(["Project bestaat niet."]);
    const directory = this.projectDir(id);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ValidationError(["Projectmap is ongeldig."]);
    return directory;
  }

  create(value: unknown): Catalog {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "name")
    )
      throw new ValidationError(["Ongeldige projectgegevens."]);
    const name = (value as { name?: unknown }).name;
    if (
      typeof name !== "string" ||
      name.trim().length < 1 ||
      name.trim().length > 64 ||
      /[\\/]|\.\./.test(name)
    )
      throw new ValidationError(["Projectnaam moet 1 tot 64 tekens bevatten."]);
    const normalized = name
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .replace(/-$/, "");
    if (!validId(normalized))
      throw new ValidationError([
        "Kies een projectnaam met letters of cijfers.",
      ]);
    const catalog = this.read();
    const before = structuredClone(catalog);
    if (catalog.projects.some((item) => item.id === normalized))
      throw new ValidationError(["Er bestaat al een project met deze naam."]);
    fs.mkdirSync(this.projectDir(normalized), { mode: 0o700 });
    catalog.projects.push({
      id: normalized,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    });
    catalog.activeId = normalized;
    this.write(catalog);
    const historyWarning = this.appendHistory(before, catalog);
    return { ...catalog, ...(historyWarning ? { historyWarning } : {}) };
  }

  select(value: unknown): Catalog {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "id")
    )
      throw new ValidationError(["Ongeldige projectkeuze."]);
    const id = (value as { id?: unknown }).id;
    if (!validId(id)) throw new ValidationError(["Ongeldig project."]);
    const catalog = this.read();
    const before = structuredClone(catalog);
    if (!catalog.projects.some((item) => item.id === id))
      throw new ValidationError(["Project bestaat niet."]);
    const stat = fs.lstatSync(this.projectDir(id));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ValidationError(["Projectmap is ongeldig."]);
    catalog.activeId = id;
    this.write(catalog);
    const historyWarning = this.appendHistory(before, catalog);
    return { ...catalog, ...(historyWarning ? { historyWarning } : {}) };
  }

  /** Restores the newest project selection (or removes the project it created) in one step. */
  rollback(revisionId: string): WorkspaceProjectSelectionResult {
    if (!/^[0-9a-f-]{36}$/i.test(revisionId))
      throw new ValidationError(["Ongeldige projectwijziging."]);
    const revisions = this.readHistory();
    const revision = revisions.find((item) => item.id === revisionId);
    const latest = revisions.at(-1);
    if (!revision || latest?.id !== revision.id)
      return { ok: false, error: "Herstel alleen de nieuwste projectkeuze." };
    const draft = {
      kind: revision.kind,
      projectId: revision.projectId,
      beforeId: revision.beforeId,
      afterId: revision.afterId,
    };
    const sessionId = "settings";
    const action = { tool: "workspace_project_selection_rollback" };
    if (this.inFlight)
      return { ok: false, error: "Er wordt al een projectkeuze teruggezet." };
    this.inFlight = true;
    try {
      const current = this.read();
      if (
        catalogDigest(current) !== revision.afterRevision ||
        current.activeId !== draft.afterId
      )
        return {
          ok: false,
          error: "Projectkeuze is intussen gewijzigd. Er is niets teruggezet.",
        };
      if (
        draft.beforeId &&
        !current.projects.some((item) => item.id === draft.beforeId)
      )
        return { ok: false, error: "Het vorige project bestaat niet meer." };
      if (draft.beforeId) {
        try {
          this.projectDirectory(draft.beforeId);
        } catch {
          return { ok: false, error: "De vorige projectmap is ongeldig." };
        }
      }
      const removingCreated = draft.kind === "created";
      const createdId = draft.projectId;
      if (removingCreated) {
        if (
          typeof createdId !== "string" ||
          createdId !== draft.afterId ||
          current.activeId !== createdId ||
          !current.projects.some((item) => item.id === createdId)
        )
          return {
            ok: false,
            error:
              "Het aangemaakte project is intussen gewijzigd. Er is niets verwijderd.",
          };
        if (!this.projectDirectoryIsEmpty(createdId))
          return {
            ok: false,
            error:
              "Het project bevat bestanden of de projectmap is ongeldig; er is niets verwijderd.",
          };
      }
      try {
        this.audit.record({
          sessionId,
          tool: action.tool,
          risk: "DANGEROUS",
          confirmation: "direct",
          phase: "before_execute",
          arguments: {
            revisionId,
            beforeId: draft.beforeId,
            afterId: draft.afterId,
          },
        });
      } catch {
        return {
          ok: false,
          error: "Herstel niet uitgevoerd: het actielog is niet beschikbaar.",
        };
      }
      const restored = structuredClone(current);
      restored.activeId = draft.beforeId;
      if (removingCreated) {
        restored.projects = restored.projects.filter(
          (item) => item.id !== createdId,
        );
        // rmdir is deliberately non-recursive: files added since the check are never deleted.
        this.write(restored);
        try {
          fs.rmdirSync(this.projectDir(createdId!));
        } catch {
          this.write(current);
          return {
            ok: false,
            error:
              "De lege projectmap kon niet veilig worden verwijderd. Er is niets teruggezet.",
          };
        }
      } else this.write(restored);
      const verified = this.read();
      if (catalogDigest(verified) !== catalogDigest(restored))
        return {
          ok: false,
          verified: false,
          error: "Projectkeuze kon niet worden gecontroleerd.",
        };
      if (removingCreated && fs.existsSync(this.projectDir(createdId!)))
        return {
          ok: false,
          verified: false,
          error:
            "De projectmap bestaat nog; terugzetten kon niet worden gecontroleerd.",
        };
      const historyWarning = this.appendHistory(current, verified);
      let auditWarning: string | undefined;
      try {
        this.audit.record({
          sessionId,
          tool: action.tool,
          risk: "DANGEROUS",
          confirmation: "direct",
          phase: "after_execute",
          arguments: { beforeId: draft.afterId, afterId: draft.beforeId },
          result: { ok: true },
          verification: { persisted: true },
        });
      } catch {
        auditWarning =
          "Projectkeuze is teruggezet, maar dit kon niet in het actielog worden afgerond.";
      }
      return {
        ok: true,
        verified: true,
        ...(auditWarning ? { auditWarning } : {}),
        ...(historyWarning ? { historyWarning } : {}),
      };
    } catch {
      return {
        ok: false,
        verified: false,
        error:
          "Projectkeuze kon niet worden teruggezet. Controleer het actieve project.",
      };
    } finally {
      this.inFlight = false;
    }
  }
}
