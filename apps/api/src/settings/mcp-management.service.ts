import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { McpHub } from "../integrations/mcp/mcp.hub.js";
import {
  isReviewedMcpServer,
  reviewedMcpCatalog,
  reviewedMcpServerSpec,
} from "../integrations/mcp/reviewed-mcp-servers.js";
import { readMcpServers, RISKS } from "../integrations/mcp/mcp-config.js";
import type { Risk } from "@nova/contracts";

type McpSettingRevision = {
  id: string;
  at: string;
  server: string;
  change:
    | { kind: "enabled"; before: boolean; after: boolean }
    | { kind: "tool-risk"; tool: string; before: Risk; after: Risk }
    | {
        kind: "catalog";
        operation: "add" | "remove";
        specFingerprint: string;
        rollbackOf?: string;
      };
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function serverFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Direct edits and private history for NOVA-owned MCP settings. */
@Injectable()
export class McpManagement {
  private readonly file: string;
  private readonly historyFile: string;
  private readonly dataRoot: string;
  private readonly editable: boolean;

  constructor(
    config: NovaConfig,
    private readonly hub: McpHub,
    private readonly audit: AuditService,
  ) {
    const file = path.resolve(config.mcpConfig);
    this.dataRoot = path.resolve(config.dataDir);
    const root = `${this.dataRoot}${path.sep}`;
    this.file = file;
    this.historyFile = path.join(this.dataRoot, "mcp-settings-history.json");
    this.editable = file.startsWith(root);
  }

  history(server: string) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(server))
      throw new ValidationError(["Ongeldige MCP-server-ID."]);
    const all = this.readHistory();
    return {
      revisions: all
        .filter((item) => item.server === server)
        .map((item) =>
          item.change.kind === "catalog"
            ? {
                id: item.id,
                at: item.at,
                server: item.server,
                change: {
                  kind: "catalog" as const,
                  operation: item.change.operation,
                },
              }
            : item,
        ),
      truncated: all.length >= 40,
    };
  }

  catalog() {
    const servers = this.editable
      ? this.read().data.servers
      : readMcpServers(this.file);
    const installed = Object.entries(servers)
      .filter(([id, spec]) => isReviewedMcpServer(id, spec as never))
      .map(([id]) => id)
      .sort();
    const installedSet = new Set(installed);
    return {
      installed,
      ...(this.editable ? {} : { editable: false }),
      available: (this.editable ? reviewedMcpCatalog() : []).filter(
        (entry) => !installedSet.has(entry.id),
      ),
    };
  }

  private writeConfig(data: unknown): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private auditAttempt(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): boolean {
    try {
      this.audit.record({
        sessionId,
        tool,
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "attempt",
        arguments: args,
      });
      return true;
    } catch {
      return false;
    }
  }

  private auditVerified(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): boolean {
    try {
      this.audit.record({
        sessionId,
        tool,
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "verified",
        arguments: args,
        result: { ok: true },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Adds a reviewed catalog server (disabled) or removes one, immediately. */
  async changeCatalog(
    server: string,
    operation: "add" | "remove",
    rollbackRevisionId?: string,
  ) {
    if (
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(server) ||
      !["add", "remove"].includes(operation)
    )
      throw new ValidationError(["Ongeldige MCP-cataloguskeuze."]);
    const spec = reviewedMcpServerSpec(server);
    if (!spec)
      throw new ValidationError([
        "Deze MCP-server staat niet in de beoordeelde catalogus.",
      ]);
    const current = this.read();
    const currentServer = current.data.servers[server];
    if (rollbackRevisionId === undefined) {
      if (
        operation === "add"
          ? currentServer !== undefined
          : !currentServer ||
            !isReviewedMcpServer(server, currentServer as never)
      )
        throw new ValidationError([
          operation === "add"
            ? "Deze MCP-server staat al ingesteld."
            : "Alleen een beoordeelde MCP-server kan worden verwijderd.",
        ]);
    }
    const sessionId = `settings-mcp-catalog:${crypto.randomUUID()}`;
    const auditArgs = { server, operation };
    if (!this.auditAttempt(sessionId, "settings_mcp_catalog_change", auditArgs))
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-wijziging gestopt.",
      };
    if (operation === "add") current.data.servers[server] = { ...spec };
    else delete current.data.servers[server];
    try {
      this.writeConfig(current.data);
    } catch {
      return {
        ok: false as const,
        error: "MCP-configuratie kon niet veilig worden opgeslagen.",
      };
    }
    try {
      const verified = this.read().data.servers[server];
      if (
        operation === "add"
          ? !verified ||
            !isReviewedMcpServer(server, verified as never) ||
            verified.enabled !== false
          : verified !== undefined
      )
        throw new Error("MCP catalog verification failed");
      await this.hub.reconfigure();
    } catch {
      return {
        ok: false as const,
        verified: null,
        error:
          "MCP-configuratie is opgeslagen maar de serverstatus kon niet worden gecontroleerd.",
      };
    }
    let historyWarning: string | undefined;
    try {
      this.appendHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        server,
        change: {
          kind: "catalog",
          operation,
          specFingerprint: serverFingerprint(
            operation === "add" ? spec : currentServer,
          ),
          ...(rollbackRevisionId ? { rollbackOf: rollbackRevisionId } : {}),
        },
      });
    } catch {
      historyWarning =
        "De MCP-catalogus is gewijzigd, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
    this.auditVerified(sessionId, "settings_mcp_catalog_change", auditArgs);
    return {
      ok: true as const,
      verified: true as const,
      server,
      operation,
      ...(historyWarning ? { warning: historyWarning } : {}),
    };
  }

  /** Reverts one history entry immediately. */
  async rollback(server: string, revisionId: string) {
    if (
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(server) ||
      !/^[0-9a-f-]{36}$/i.test(revisionId)
    )
      throw new ValidationError(["Ongeldige MCP-herstelkeuze."]);
    const revision = this.readHistory().find(
      (item) => item.id === revisionId && item.server === server,
    );
    if (!revision)
      throw new ValidationError([
        "Deze MCP-wijziging staat niet in de geschiedenis.",
      ]);
    const { data } = this.read();
    if (revision.change.kind === "catalog") {
      const latest = this.readHistory().find((item) => item.server === server);
      const spec = data.servers[server];
      const canonical = reviewedMcpServerSpec(server);
      if (
        revision.change.operation !== "add" ||
        latest?.id !== revision.id ||
        !spec ||
        spec.enabled !== false ||
        !canonical ||
        !isReviewedMcpServer(server, spec as never) ||
        serverFingerprint(spec) !== revision.change.specFingerprint ||
        serverFingerprint(spec) !== serverFingerprint(canonical)
      )
        throw new ValidationError([
          "Alleen een ongewijzigde, uitgeschakelde NOVA-toevoeging kan worden teruggedraaid.",
        ]);
      return this.changeCatalog(server, "remove", revision.id);
    }
    const spec = data.servers[server];
    if (!spec)
      throw new ValidationError(["Deze MCP-server is niet meer ingesteld."]);
    const change = revision.change;
    if (change.kind === "tool-risk") {
      const currentRisk =
        spec.toolRisks && typeof spec.toolRisks === "object"
          ? (spec.toolRisks as Record<string, unknown>)[change.tool]
          : undefined;
      const status = this.hub
        .status()
        .servers.find((entry) => entry.id === server);
      if (
        spec.enabled === false ||
        currentRisk !== change.after ||
        !status?.tools.some((entry) => entry.name === change.tool)
      )
        throw new ValidationError([
          "MCP-gereedschapsrisico is intussen gewijzigd of niet actief. Bekijk de status opnieuw.",
        ]);
      return this.setToolRisk(server, change.tool, change.before);
    }
    if ((spec.enabled !== false) !== change.after)
      throw new ValidationError([
        "MCP-stand is intussen gewijzigd. Bekijk de status opnieuw.",
      ]);
    return this.setEnabled(server, change.before);
  }

  private readHistory(): McpSettingRevision[] {
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.lstatSync(this.historyFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid");
      raw = fs.readFileSync(this.historyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ValidationError([
        "MCP-wijzigingsgeschiedenis is niet leesbaar.",
      ]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new ValidationError(["MCP-wijzigingsgeschiedenis is ongeldig."]);
    }
    if (!Array.isArray(parsed) || parsed.length > 40)
      throw new ValidationError(["MCP-wijzigingsgeschiedenis is ongeldig."]);
    const revisions: McpSettingRevision[] = [];
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(item.id) ||
        typeof item.at !== "string" ||
        !Number.isFinite(Date.parse(item.at)) ||
        typeof item.server !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,80}$/.test(item.server)
      )
        throw new ValidationError(["MCP-wijzigingsgeschiedenis is ongeldig."]);
      if (
        item.change?.kind === "enabled" &&
        typeof item.change.before === "boolean" &&
        typeof item.change.after === "boolean" &&
        item.change.before !== item.change.after
      ) {
        revisions.push({
          id: item.id,
          at: item.at,
          server: item.server,
          change: {
            kind: "enabled",
            before: item.change.before,
            after: item.change.after,
          },
        });
      } else if (
        item.change?.kind === "tool-risk" &&
        typeof item.change.tool === "string" &&
        /^[a-zA-Z0-9_.-]{1,128}$/.test(item.change.tool) &&
        RISKS.includes(item.change.before as Risk) &&
        RISKS.includes(item.change.after as Risk) &&
        item.change.before !== item.change.after
      ) {
        revisions.push({
          id: item.id,
          at: item.at,
          server: item.server,
          change: {
            kind: "tool-risk",
            tool: item.change.tool,
            before: item.change.before as Risk,
            after: item.change.after as Risk,
          },
        });
      } else if (
        item.change?.kind === "catalog" &&
        (item.change.operation === "add" ||
          item.change.operation === "remove") &&
        typeof item.change.specFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(item.change.specFingerprint) &&
        (item.change.rollbackOf === undefined ||
          (typeof item.change.rollbackOf === "string" &&
            /^[0-9a-f-]{36}$/i.test(item.change.rollbackOf)))
      ) {
        revisions.push({
          id: item.id,
          at: item.at,
          server: item.server,
          change: {
            kind: "catalog",
            operation: item.change.operation,
            specFingerprint: item.change.specFingerprint,
            ...(item.change.rollbackOf
              ? { rollbackOf: item.change.rollbackOf }
              : {}),
          },
        });
      } else {
        throw new ValidationError(["MCP-wijzigingsgeschiedenis is ongeldig."]);
      }
    }
    return revisions;
  }

  private appendHistory(revision: McpSettingRevision): void {
    const revisions = [revision, ...this.readHistory()].slice(0, 40);
    fs.mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${this.historyFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(revisions, null, 2), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.historyFile);
      const directory = fs.openSync(this.dataRoot, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private read() {
    if (!this.editable)
      throw new ValidationError([
        "MCP-configuratie is niet door NOVA lokaal beheerd.",
      ]);
    let root: string;
    let parent: string;
    try {
      root = fs.realpathSync(this.dataRoot);
      parent = fs.realpathSync(path.dirname(this.file));
    } catch {
      throw new ValidationError([
        "MCP-configuratie is niet lokaal beschikbaar.",
      ]);
    }
    const relativeParent = path.relative(root, parent);
    if (
      relativeParent === ".." ||
      relativeParent.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeParent)
    )
      throw new ValidationError([
        "MCP-configuratie verwijst buiten NOVA's gegevensmap.",
      ]);
    let stat: fs.Stats;
    let raw: Buffer;
    let parsed: unknown;
    try {
      stat = fs.lstatSync(this.file);
      raw = fs.readFileSync(this.file);
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      throw new ValidationError(["MCP-configuratie ontbreekt of is ongeldig."]);
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ValidationError([
        "MCP-configuratie is niet lokaal beheerbaar.",
      ]);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("servers" in parsed) ||
      !parsed.servers ||
      typeof parsed.servers !== "object" ||
      Array.isArray(parsed.servers)
    )
      throw new ValidationError(["MCP-configuratie is ongeldig."]);
    return {
      data: parsed as { servers: Record<string, Record<string, unknown>> },
    };
  }

  async setEnabled(server: string, enabled: boolean) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(server) || typeof enabled !== "boolean")
      throw new ValidationError(["Ongeldige MCP-wijziging."]);
    const current = this.read();
    const spec = current.data.servers[server];
    if (!spec || typeof spec.command !== "string" || !spec.command)
      throw new ValidationError(["Deze MCP-server is niet ingesteld."]);
    if ((spec.enabled !== false) === enabled)
      throw new ValidationError(["Deze MCP-server staat al in die stand."]);
    const sessionId = `settings-mcp:${crypto.randomUUID()}`;
    const auditArgs = { server, enabled };
    if (!this.auditAttempt(sessionId, "settings_mcp_server_toggle", auditArgs))
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-wijziging gestopt.",
      };
    const previousEnabled = spec.enabled !== false;
    spec.enabled = enabled;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.writeConfig(current.data);
    let warning: string | undefined;
    try {
      this.appendHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        server,
        change: { kind: "enabled", before: previousEnabled, after: enabled },
      });
    } catch {
      warning =
        "MCP-stand is gewijzigd, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
    try {
      await this.hub.reconfigure();
    } catch {
      warning = [
        warning,
        "Configuratie is opgeslagen; de MCP-verbinding kon nog niet worden bijgewerkt.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (!this.auditVerified(sessionId, "settings_mcp_server_toggle", auditArgs))
      warning =
        "MCP-stand is gewijzigd, maar de resultaatmelding kon niet worden geauditeerd.";
    return {
      ok: true as const,
      server,
      enabled,
      ...(warning ? { warning } : {}),
    };
  }

  async setToolRisk(server: string, tool: string, risk: Risk) {
    if (
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(server) ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool) ||
      !RISKS.includes(risk)
    )
      throw new ValidationError(["Ongeldige MCP-risicowijziging."]);
    const current = this.read();
    const spec = current.data.servers[server];
    if (!spec || spec.enabled === false)
      throw new ValidationError(["Deze MCP-server staat niet aan."]);
    if (
      !this.hub
        .status()
        .servers.some(
          (entry) =>
            entry.id === server &&
            entry.tools.some((item) => item.name === tool),
        )
    )
      throw new ValidationError([
        "Dit gereedschap is niet actief. Haal eerst de serverstatus opnieuw op.",
      ]);
    const existingRisks =
      spec.toolRisks &&
      typeof spec.toolRisks === "object" &&
      !Array.isArray(spec.toolRisks)
        ? (spec.toolRisks as Record<string, unknown>)
        : {};
    const effectiveRisk = existingRisks[tool] ?? spec.risk;
    if (effectiveRisk === risk)
      throw new ValidationError(["Dit gereedschap heeft dit risico al."]);
    const sessionId = `settings-mcp:${crypto.randomUUID()}`;
    const auditArgs = { server, tool, risk };
    if (!this.auditAttempt(sessionId, "settings_mcp_tool_risk", auditArgs))
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-risicowijziging gestopt.",
      };
    const previousRisk = RISKS.includes(existingRisks[tool] as Risk)
      ? (existingRisks[tool] as Risk)
      : RISKS.includes(spec.risk as Risk)
        ? (spec.risk as Risk)
        : "CONFIRM";
    spec.toolRisks = { ...existingRisks, [tool]: risk };
    this.writeConfig(current.data);
    let warning: string | undefined;
    try {
      this.appendHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        server,
        change: { kind: "tool-risk", tool, before: previousRisk, after: risk },
      });
    } catch {
      warning =
        "Risiconiveau is gewijzigd, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
    try {
      await this.hub.refresh(server);
    } catch {
      warning = [
        warning,
        "Risiconiveau is opgeslagen; de MCP-gereedschappen konden niet direct worden vernieuwd.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (!this.auditVerified(sessionId, "settings_mcp_tool_risk", auditArgs))
      warning =
        "Risiconiveau is gewijzigd, maar de resultaatmelding kon niet worden geauditeerd.";
    return {
      ok: true as const,
      server,
      tool,
      risk,
      ...(warning ? { warning } : {}),
    };
  }
}
