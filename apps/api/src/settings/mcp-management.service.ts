import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
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

type Draft = {
  sessionId: string;
  server: string;
  enabled: boolean;
  tool?: string;
  risk?: Risk;
  fileDigest: string;
  expiresAt: number;
  rollbackRevisionId?: string;
  catalogOperation?: "add" | "remove";
};

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

/** One-time confirmed edits and private history for NOVA-owned MCP settings. */
@Injectable()
export class McpManagement {
  private readonly drafts = new Map<string, Draft>();
  private readonly fingerprintKey = crypto.randomBytes(32);
  private readonly file: string;
  private readonly historyFile: string;
  private readonly dataRoot: string;
  private readonly editable: boolean;

  constructor(
    config: NovaConfig,
    private readonly hub: McpHub,
    private readonly confirmations: ConfirmationsService,
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

  prepareCatalog(server: string, operation: "add" | "remove") {
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now()) this.drafts.delete(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
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
    const { data, fileDigest } = this.read();
    const current = data.servers[server];
    if (
      operation === "add"
        ? current !== undefined
        : !current || !isReviewedMcpServer(server, current as never)
    )
      throw new ValidationError([
        operation === "add"
          ? "Deze MCP-server staat al ingesteld."
          : "Alleen een beoordeelde MCP-server kan worden verwijderd.",
      ]);
    const sessionId = `settings-mcp-catalog:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "settings_mcp_catalog_change",
      { server, operation },
      "DANGEROUS",
      undefined,
      false,
    );
    try {
      this.audit.record({
        sessionId,
        tool: "settings_mcp_catalog_change",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { server, operation },
      });
    } catch {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-wijziging gestopt.",
      };
    }
    this.drafts.set(action.confirmationId, {
      sessionId,
      server,
      enabled: false,
      catalogOperation: operation,
      fileDigest,
      expiresAt: action.expiresAt,
    });
    return {
      ok: true as const,
      warning:
        operation === "add"
          ? "De beoordeelde MCP-server wordt toegevoegd en blijft uitgeschakeld tot je hem apart inschakelt."
          : "De MCP-server wordt uit de configuratie verwijderd en een actieve verbinding wordt direct gesloten.",
      action,
    };
  }

  async confirmCatalog(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ) {
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      !draft.catalogOperation ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= Date.now() ||
      pending?.tool !== "settings_mcp_catalog_change" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true as const, cancelled: true as const };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    let current: ReturnType<McpManagement["read"]>;
    try {
      current = this.read();
    } catch {
      return {
        ok: false as const,
        error: "MCP-configuratie is niet leesbaar; niets gewijzigd.",
      };
    }
    const operation = draft.catalogOperation;
    const spec = reviewedMcpServerSpec(draft.server);
    const rollbackRevision = draft.rollbackRevisionId
      ? this.readHistory().find(
          (item) =>
            item.id === draft.rollbackRevisionId &&
            item.server === draft.server &&
            item.change.kind === "catalog" &&
            item.change.operation === "add",
        )
      : undefined;
    const latestServerRevision = this.readHistory().find(
      (item) => item.server === draft.server,
    );
    const currentServer = current.data.servers[draft.server];
    const validCatalogRollback =
      !draft.rollbackRevisionId ||
      (!!rollbackRevision &&
        latestServerRevision?.id === rollbackRevision.id &&
        rollbackRevision.change.kind === "catalog" &&
        !!spec &&
        currentServer?.enabled === false &&
        serverFingerprint(currentServer) ===
          rollbackRevision.change.specFingerprint &&
        serverFingerprint(currentServer) === serverFingerprint(spec));
    if (
      action.args.server !== draft.server ||
      action.args.operation !== operation ||
      (draft.rollbackRevisionId !== undefined &&
        action.args.rollbackRevisionId !== draft.rollbackRevisionId) ||
      current.fileDigest !== draft.fileDigest ||
      !spec ||
      !validCatalogRollback ||
      (!draft.rollbackRevisionId &&
        (operation === "add"
          ? currentServer !== undefined
          : !currentServer ||
            !isReviewedMcpServer(draft.server, currentServer as never)))
    )
      return {
        ok: false as const,
        error:
          "MCP-configuratie is intussen gewijzigd. Bekijk de catalogus opnieuw.",
      };
    try {
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: "DANGEROUS",
        confirmation: "approved_admin_ui",
        phase: "attempt",
        arguments: { server: draft.server, operation },
      });
    } catch {
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-wijziging gestopt.",
      };
    }
    if (operation === "add") current.data.servers[draft.server] = { ...spec };
    else delete current.data.servers[draft.server];
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(current.data, null, 2), {
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
    } catch {
      return {
        ok: false as const,
        error: "MCP-configuratie kon niet veilig worden opgeslagen.",
      };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    try {
      const verified = this.read().data.servers[draft.server];
      if (
        operation === "add"
          ? !verified ||
            !isReviewedMcpServer(draft.server, verified as never) ||
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
        server: draft.server,
        change: {
          kind: "catalog",
          operation,
          specFingerprint: serverFingerprint(
            operation === "add" ? spec : currentServer,
          ),
          ...(draft.rollbackRevisionId
            ? { rollbackOf: draft.rollbackRevisionId }
            : {}),
        },
      });
    } catch {
      historyWarning =
        "De MCP-catalogus is gewijzigd, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
    // The attempt record already exists. Do not turn a verified filesystem and
    // hub change into an apparent failure if the final audit append fails.
    try {
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        phase: "verified",
        arguments: { server: draft.server, operation },
        result: { ok: true },
      });
    } catch {
      // The safe outcome is still independently verified above.
    }
    return {
      ok: true as const,
      verified: true as const,
      server: draft.server,
      operation,
      ...(historyWarning ? { warning: historyWarning } : {}),
    };
  }

  prepareRollback(server: string, revisionId: string) {
    if (
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(server) ||
      !/^[0-9a-f-]{36}$/i.test(revisionId)
    )
      throw new ValidationError(["Ongeldige MCP-herstelkeuze."]);
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now()) this.drafts.delete(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
    const revision = this.readHistory().find(
      (item) => item.id === revisionId && item.server === server,
    );
    if (!revision)
      throw new ValidationError([
        "Deze MCP-wijziging staat niet in de geschiedenis.",
      ]);
    const { data, fileDigest } = this.read();
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
      const sessionId = `settings-mcp-catalog:${crypto.randomUUID()}`;
      const action = this.confirmations.create(
        sessionId,
        "settings_mcp_catalog_change",
        { server, operation: "remove", rollbackRevisionId: revision.id },
        "DANGEROUS",
        undefined,
        false,
      );
      try {
        this.audit.record({
          sessionId,
          tool: "settings_mcp_catalog_change",
          risk: "DANGEROUS",
          confirmation: "pending_admin_ui",
          arguments: { server, operation: "remove", rollback: true },
        });
      } catch {
        this.confirmations.cancel(sessionId, "rejected_admin_ui");
        return {
          ok: false as const,
          error: "Auditlog niet beschikbaar; MCP-herstel gestopt.",
        };
      }
      this.drafts.set(action.confirmationId, {
        sessionId,
        server,
        enabled: false,
        catalogOperation: "remove",
        rollbackRevisionId: revision.id,
        fileDigest,
        expiresAt: action.expiresAt,
      });
      return {
        ok: true as const,
        warning:
          "Dit verwijdert alleen de ongewijzigde MCP-server die NOVA heeft toegevoegd. De server moet uitgeschakeld blijven; apart opgeslagen inloggegevens blijven bewaard. Eenmalige gevaarlijke bevestiging vereist.",
        action,
      };
    }
    const spec = data.servers[server];
    if (!spec)
      throw new ValidationError(["Deze MCP-server is niet meer ingesteld."]);
    const change = revision.change;
    let tool: string | undefined;
    let rollbackRisk: Risk | undefined;
    if (change.kind === "tool-risk") {
      tool = change.tool;
      rollbackRisk = change.before;
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
    } else if ((spec.enabled !== false) !== change.after) {
      throw new ValidationError([
        "MCP-stand is intussen gewijzigd. Bekijk de status opnieuw.",
      ]);
    }
    const isRiskChange = change.kind === "tool-risk";
    const risk = rollbackRisk;
    const enabled =
      change.kind === "enabled" ? change.before : spec.enabled !== false;
    const confirmationTool = isRiskChange
      ? "settings_mcp_tool_risk"
      : "settings_mcp_server_toggle";
    const args = isRiskChange
      ? { server, tool, risk, rollbackRevisionId: revision.id }
      : { server, enabled, rollbackRevisionId: revision.id };
    const sessionId = `settings-mcp:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      confirmationTool,
      args,
      "DANGEROUS",
      undefined,
      false,
    );
    try {
      this.audit.record({
        sessionId,
        tool: confirmationTool,
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: isRiskChange
          ? { server, tool, risk, rollback: true }
          : { server, enabled, rollback: true },
      });
    } catch {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-herstel gestopt.",
      };
    }
    const rollbackDraft: Draft = {
      sessionId,
      server,
      enabled,
      fileDigest,
      expiresAt: action.expiresAt,
      rollbackRevisionId: revision.id,
    };
    if (tool !== undefined && risk !== undefined) {
      rollbackDraft.tool = tool;
      rollbackDraft.risk = risk;
    }
    this.drafts.set(action.confirmationId, rollbackDraft);
    return {
      ok: true as const,
      warning: isRiskChange
        ? `Dit zet het eerdere risico voor ${tool} terug naar ${risk}. Eenmalige gevaarlijke bevestiging vereist.`
        : "Dit zet de eerdere MCP-stand terug en start of stopt de MCP-server. Eenmalige gevaarlijke bevestiging vereist.",
      action,
    };
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
    const fileDigest = crypto
      .createHmac("sha256", this.fingerprintKey)
      .update(raw)
      .digest("hex");
    return {
      data: parsed as { servers: Record<string, Record<string, unknown>> },
      fileDigest,
    };
  }

  prepare(server: string, enabled: boolean) {
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now()) this.drafts.delete(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(server) || typeof enabled !== "boolean")
      throw new ValidationError(["Ongeldige MCP-wijziging."]);
    const { data, fileDigest } = this.read();
    const spec = data.servers[server];
    if (!spec || typeof spec.command !== "string" || !spec.command)
      throw new ValidationError(["Deze MCP-server is niet ingesteld."]);
    if ((spec.enabled !== false) === enabled)
      throw new ValidationError(["Deze MCP-server staat al in die stand."]);
    const sessionId = `settings-mcp:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "settings_mcp_server_toggle",
      { server, enabled },
      "DANGEROUS",
      undefined,
      false,
    );
    try {
      this.audit.record({
        sessionId,
        tool: "settings_mcp_server_toggle",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { server, enabled },
      });
    } catch {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-wijziging gestopt.",
      };
    }
    this.drafts.set(action.confirmationId, {
      sessionId,
      server,
      enabled,
      fileDigest,
      expiresAt: action.expiresAt,
    });
    return {
      ok: true as const,
      warning: enabled
        ? "Inschakelen start het ingestelde MCP-programma en stelt de bijbehorende gereedschappen beschikbaar."
        : "Uitschakelen stopt het MCP-programma en haalt de gereedschappen weg.",
      action,
    };
  }

  prepareToolRisk(server: string, tool: string, risk: Risk) {
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now()) this.drafts.delete(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
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
    const toolRisks = spec.toolRisks;
    const currentRisk =
      toolRisks && typeof toolRisks === "object" && !Array.isArray(toolRisks)
        ? (toolRisks as Record<string, unknown>)[tool]
        : undefined;
    const effectiveRisk = currentRisk ?? spec.risk;
    if (effectiveRisk === risk)
      throw new ValidationError(["Dit gereedschap heeft dit risico al."]);
    const sessionId = `settings-mcp:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "settings_mcp_tool_risk",
      { server, tool, risk },
      "DANGEROUS",
      undefined,
      false,
    );
    try {
      this.audit.record({
        sessionId,
        tool: "settings_mcp_tool_risk",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { server, tool, risk },
      });
    } catch {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; MCP-risicowijziging gestopt.",
      };
    }
    this.drafts.set(action.confirmationId, {
      sessionId,
      server,
      enabled: spec.enabled !== false,
      tool,
      risk,
      fileDigest: current.fileDigest,
      expiresAt: action.expiresAt,
    });
    return {
      ok: true as const,
      warning:
        "Dit wijzigt het risiconiveau van één MCP-gereedschap. De volgende uitvoering gebruikt deze bevestigingsregels.",
      action,
    };
  }

  async confirmToolRisk(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ) {
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      !draft.tool ||
      !draft.risk ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= Date.now() ||
      pending?.confirmationId !== confirmationId
    )
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true as const, cancelled: true as const };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    let current: ReturnType<McpManagement["read"]>;
    try {
      current = this.read();
    } catch {
      return {
        ok: false as const,
        error: "MCP-configuratie is niet leesbaar; niets gewijzigd.",
      };
    }
    const spec = current.data.servers[draft.server];
    if (
      action.args.server !== draft.server ||
      action.args.tool !== draft.tool ||
      action.args.risk !== draft.risk ||
      (draft.rollbackRevisionId !== undefined &&
        action.args.rollbackRevisionId !== draft.rollbackRevisionId) ||
      current.fileDigest !== draft.fileDigest ||
      !spec ||
      spec.enabled === false ||
      !this.hub
        .status()
        .servers.some(
          (entry) =>
            entry.id === draft.server &&
            entry.tools.some((item) => item.name === draft.tool),
        )
    )
      return {
        ok: false as const,
        error:
          "MCP-configuratie of gereedschapsstatus is intussen gewijzigd. Bekijk de status opnieuw.",
      };
    this.audit.record({
      sessionId,
      tool: "settings_mcp_tool_risk",
      risk: "DANGEROUS",
      confirmation: "approved_admin_ui",
      arguments: { server: draft.server, tool: draft.tool, risk: draft.risk },
      phase: "attempt",
    });
    const existingRisks =
      spec.toolRisks &&
      typeof spec.toolRisks === "object" &&
      !Array.isArray(spec.toolRisks)
        ? (spec.toolRisks as Record<string, unknown>)
        : {};
    const previousRisk = RISKS.includes(existingRisks[draft.tool] as Risk)
      ? (existingRisks[draft.tool] as Risk)
      : RISKS.includes(spec.risk as Risk)
        ? (spec.risk as Risk)
        : "CONFIRM";
    spec.toolRisks = { ...existingRisks, [draft.tool]: draft.risk };
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(current.data, null, 2), {
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
    let warning: string | undefined;
    try {
      this.appendHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        server: draft.server,
        change: {
          kind: "tool-risk",
          tool: draft.tool,
          before: previousRisk,
          after: draft.risk,
        },
      });
    } catch {
      warning =
        "Risiconiveau is gewijzigd, maar de lokale wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
    try {
      await this.hub.refresh(draft.server);
    } catch {
      warning = [
        warning,
        "Risiconiveau is opgeslagen; de MCP-gereedschappen konden niet direct worden vernieuwd.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    try {
      this.audit.record({
        sessionId,
        tool: "settings_mcp_tool_risk",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        arguments: { server: draft.server, tool: draft.tool, risk: draft.risk },
        result: { ok: true },
        phase: "verified",
      });
    } catch {
      warning =
        "Risiconiveau is gewijzigd, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      server: draft.server,
      tool: draft.tool,
      risk: draft.risk,
      ...(warning ? { warning } : {}),
    };
  }

  async confirm(sessionId: string, confirmationId: string, approve: boolean) {
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= Date.now() ||
      pending?.confirmationId !== confirmationId
    )
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true as const, cancelled: true as const };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    let current: ReturnType<McpManagement["read"]>;
    try {
      current = this.read();
    } catch {
      return {
        ok: false as const,
        error: "MCP-configuratie is niet leesbaar; niets gewijzigd.",
      };
    }
    if (
      action.args.server !== draft.server ||
      action.args.enabled !== draft.enabled ||
      (draft.rollbackRevisionId !== undefined &&
        action.args.rollbackRevisionId !== draft.rollbackRevisionId) ||
      current.fileDigest !== draft.fileDigest ||
      (current.data.servers[draft.server]?.enabled !== false) === draft.enabled
    )
      return {
        ok: false as const,
        error:
          "MCP-configuratie is intussen gewijzigd. Bekijk de status opnieuw.",
      };
    this.audit.record({
      sessionId,
      tool: "settings_mcp_server_toggle",
      risk: "DANGEROUS",
      confirmation: "approved_admin_ui",
      arguments: { server: draft.server, enabled: draft.enabled },
      phase: "attempt",
    });
    const previousEnabled =
      current.data.servers[draft.server]!.enabled !== false;
    current.data.servers[draft.server]!.enabled = draft.enabled;
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify(current.data, null, 2), {
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
    let warning: string | undefined;
    try {
      this.appendHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        server: draft.server,
        change: {
          kind: "enabled",
          before: previousEnabled,
          after: draft.enabled,
        },
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
    try {
      this.audit.record({
        sessionId,
        tool: "settings_mcp_server_toggle",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        arguments: { server: draft.server, enabled: draft.enabled },
        result: { ok: true },
        phase: "verified",
      });
    } catch {
      warning =
        "MCP-stand is gewijzigd, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      server: draft.server,
      enabled: draft.enabled,
      ...(warning ? { warning } : {}),
    };
  }
}
