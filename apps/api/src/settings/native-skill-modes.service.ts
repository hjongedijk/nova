import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  NativeSkillMode,
  NativeSkillModeHistory,
  NativeSkillModeRevision,
  NativeSkillModeResult,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { ValidationError } from "../core/errors/validation.error.js";

type Row = {
  id: string;
  api_key_id: string;
  name: string;
  handler: string;
  schema: string;
  mode: string;
  enabled: number;
  updated_at: string;
};
type StoredRevision = NativeSkillModeRevision & {
  skillId: string;
  beforeRevision: string;
  afterRevision: string;
};
const MAX_HISTORY = 20;
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (row: Row) =>
  hash([row.id, row.api_key_id, row.name, row.handler, row.schema]);
const revision = (row: Row) =>
  hash([binding(row), row.mode, row.enabled, row.updated_at]);
const revisionHash = revision;
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const globalOwners = new Set(["system", "skillsmp", "skillssh"]);
const validMode = (value: unknown): value is NativeSkillMode =>
  value === "on" || value === "off" || value === "auto";
const unavailable =
  "Skillbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Native mode changes stay in the settings API; there is no corresponding model tool. */
@Injectable()
export class NativeSkillModesService {
  private readonly inFlight = new Set<string>();
  private readonly historyFile: string;
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
  ) {
    this.historyFile = config.dataFile("native-skill-mode-history.json");
  }

  private readHistory(): StoredRevision[] {
    let raw: unknown;
    try {
      const stat = fs.lstatSync(this.historyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        throw new Error("invalid history");
      raw = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ValidationError(["Skillgeschiedenis is niet leesbaar."]);
    }
    if (!Array.isArray(raw) || raw.length > MAX_HISTORY)
      throw new ValidationError(["Skillgeschiedenis is ongeldig."]);
    return raw.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(item.id) ||
        !validId(item.skillId) ||
        !validMode(item.before) ||
        !validMode(item.after) ||
        item.before === item.after ||
        (item.scope !== "nova" && item.scope !== "global") ||
        typeof item.at !== "string" ||
        !Number.isFinite(Date.parse(item.at)) ||
        typeof item.beforeRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.beforeRevision) ||
        typeof item.afterRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.afterRevision) ||
        (item.revertedFrom !== undefined &&
          (typeof item.revertedFrom !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(item.revertedFrom)))
      )
        throw new ValidationError(["Skillgeschiedenis is ongeldig."]);
      return {
        id: item.id,
        skillId: item.skillId,
        at: new Date(item.at).toISOString(),
        before: item.before,
        after: item.after,
        scope: item.scope,
        beforeRevision: item.beforeRevision,
        afterRevision: item.afterRevision,
        ...(item.revertedFrom ? { revertedFrom: item.revertedFrom } : {}),
      };
    });
  }

  history(id: string): NativeSkillModeHistory {
    if (!validId(id)) throw new ValidationError(["Ongeldige skill."]);
    this.row(id);
    const all = this.readHistory();
    const revisions = all
      .filter((item) => item.skillId === id)
      .slice(-MAX_HISTORY)
      .reverse()
      .map(({ id: revisionId, at, before, after, scope, revertedFrom }) => ({
        id: revisionId,
        at,
        before,
        after,
        scope,
        ...(revertedFrom ? { revertedFrom } : {}),
      }));
    return {
      revisions,
      truncated: all.length === MAX_HISTORY,
    };
  }

  private appendHistory(
    id: string,
    scope: "nova" | "global",
    before: Row,
    after: Row,
    revertedFrom?: string,
  ): void {
    if (before.mode === after.mode) return;
    const revision: StoredRevision = {
      id: crypto.randomUUID(),
      skillId: id,
      at: new Date().toISOString(),
      before: before.mode as NativeSkillMode,
      after: after.mode as NativeSkillMode,
      scope,
      beforeRevision: revisionHash(before),
      afterRevision: revisionHash(after),
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    const entries = [...this.readHistory(), revision].slice(-MAX_HISTORY);
    fs.mkdirSync(path.dirname(this.historyFile), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.historyFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.historyFile);
      const directory = fs.openSync(path.dirname(this.historyFile), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private row(id: string): Row {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const owner = this.management.scope;
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id,api_key_id,name,handler,schema,mode,enabled,updated_at FROM skills WHERE id=?",
        )
        .get(id) as Row | undefined;
      if (
        !row ||
        (row.api_key_id !== owner && !globalOwners.has(row.api_key_id)) ||
        !validMode(row.mode) ||
        (row.enabled !== 0 && row.enabled !== 1)
      )
        throw new Error(unavailable);
      return row;
    } finally {
      db.close();
    }
  }

  /** Changes a skill mode immediately. */
  async setMode(
    id: string,
    mode: unknown,
    rollbackRevisionId?: string,
  ): Promise<NativeSkillModeResult> {
    if (!validId(id) || !validMode(mode))
      throw new ValidationError(["Kies een geldige skill en modus."]);
    if (this.inFlight.has(id))
      return {
        ok: false,
        error:
          "Deze skill wordt al gewijzigd. Probeer opnieuw zodra die klaar is.",
      };
    this.inFlight.add(id);
    try {
      let before: Row;
      let risk: "DANGEROUS" | "CONFIRM";
      try {
        before = this.row(id);
        const scope =
          before.api_key_id === this.management.scope ? "nova" : "global";
        risk =
          scope === "global"
            ? "DANGEROUS"
            : mode === "off"
              ? "CONFIRM"
              : "DANGEROUS";
        this.audit.record({
          sessionId: "settings",
          tool: "native_skill_mode",
          risk,
          confirmation: "direct",
          phase: "before_execute",
          arguments: { id, mode },
        });
      } catch {
        return { ok: false, error: unavailable };
      }
      try {
        await this.management.request(`/api/skills/${id}`, {
          method: "PUT",
          body: { mode },
        });
        const after = this.row(id);
        if (
          binding(after) !== binding(before) ||
          after.mode !== mode ||
          after.enabled !== (mode === "off" ? 0 : 1)
        )
          throw new Error("Persistence not verified");
        const result: NativeSkillModeResult = {
          ok: true,
          verified: true,
          mode,
          enabled: after.enabled === 1,
          name: String(sanitize(before.name)).slice(0, 200),
          scope:
            before.api_key_id === this.management.scope ? "nova" : "global",
        };
        try {
          this.appendHistory(
            id,
            before.api_key_id === this.management.scope ? "nova" : "global",
            before,
            after,
            rollbackRevisionId,
          );
        } catch {
          result.historyWarning =
            "Skillmodus is opgeslagen en gecontroleerd, maar de lokale geschiedenis kon niet worden opgeslagen.";
        }
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_mode",
            risk,
            confirmation: "direct",
            phase: "after_execute",
            arguments: { id, mode },
            result: { ok: true },
            verification: { persisted: true, runtimeMayBeCached: true },
          });
        } catch {
          result.auditWarning =
            "Opgeslagen en gecontroleerd; de afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_mode",
            risk,
            confirmation: "direct",
            phase: "after_execute",
            arguments: { id, mode },
            result: { ok: false },
            verification: { persisted: null },
          });
        } catch {
          /* Pre-execution audit remains available. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "De opgeslagen wijziging kon niet worden gecontroleerd. Laad het overzicht opnieuw voordat je verdergaat.",
        };
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Restores the newest mode change of a skill. */
  async rollback(
    id: string,
    revisionId: string,
  ): Promise<NativeSkillModeResult> {
    if (!/^[0-9a-f-]{36}$/i.test(revisionId))
      throw new ValidationError(["Ongeldige skillgeschiedenis."]);
    let latest: StoredRevision | undefined;
    try {
      latest = this.readHistory()
        .filter((item) => item.skillId === id)
        .at(-1);
      if (!latest || latest.id !== revisionId)
        return {
          ok: false,
          error: "Herstel alleen de nieuwste skillwijziging.",
        };
      const current = this.row(id);
      if (
        revision(current) !== latest.afterRevision ||
        current.mode !== latest.after
      )
        return {
          ok: false,
          error:
            "De skill is ondertussen gewijzigd. Laad de geschiedenis opnieuw.",
        };
    } catch {
      return { ok: false, error: unavailable };
    }
    return this.setMode(id, latest.before, latest.id);
  }
}
