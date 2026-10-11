import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { AuditService } from "../../core/audit/audit.service.js";
import { NovaConfig } from "../../core/config/nova-config.js";
import { ValidationError } from "../../core/errors/validation.error.js";

const FIELDS = {
  caldav: ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"],
  imap: ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"],
} as const;
type McpConfigId = keyof typeof FIELDS;
type SecretValues = Record<string, string>;

/** Local private values for the fixed mail/calendar MCP catalog entries. */
@Injectable()
export class McpSecretsStore {
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("mcp-secrets.json");
  }

  private read(): Record<string, SecretValues> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return {};
      const data = parsed as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(FIELDS).flatMap(([server, fields]) => {
          const row = data[server];
          if (!row || typeof row !== "object" || Array.isArray(row)) return [];
          const values = row as Record<string, unknown>;
          return [
            [
              server,
              Object.fromEntries(
                fields.flatMap((field) =>
                  typeof values[field] === "string" &&
                  values[field].length <= 2048
                    ? [[field, values[field]]]
                    : [],
                ),
              ),
            ],
          ];
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new ValidationError(["MCP-geheimenbestand is niet leesbaar."]);
    }
  }

  /** Values in the private store override deployment environment defaults. */
  environment(): Record<string, string> {
    return Object.assign({}, ...Object.values(this.read()));
  }

  status(server: string) {
    const fields = FIELDS[server as McpConfigId];
    if (!fields)
      throw new ValidationError(["Deze MCP-server heeft geen invoervelden."]);
    const saved = this.read()[server] ?? {};
    return {
      fields: fields.map((key) => ({
        key,
        configured: Boolean(saved[key] || process.env[key]),
      })),
    };
  }

  /** Blank inputs preserve existing values; only an explicit clear removes them. */
  save(server: string, input: unknown, clear = false) {
    const fields = FIELDS[server as McpConfigId];
    if (!fields)
      throw new ValidationError(["Deze MCP-server heeft geen invoervelden."]);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ValidationError(["Ongeldige MCP-instellingen."]);
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !fields.includes(key as never)))
      throw new ValidationError(["Onbekend MCP-invoerveld."]);
    const submitted: SecretValues = {};
    for (const key of fields) {
      const value = raw[key] ?? "";
      const hasControl =
        typeof value === "string" &&
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        });
      if (typeof value !== "string" || value.length > 2048 || hasControl)
        throw new ValidationError(["MCP-instelling is ongeldig."]);
      submitted[key] = key.endsWith("PASSWORD") ? value : value.trim();
    }
    if (server === "caldav" && submitted.CALDAV_URL) {
      let url: URL;
      try {
        url = new URL(submitted.CALDAV_URL);
      } catch {
        throw new ValidationError(["CalDAV-adres moet een HTTPS-URL zijn."]);
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new ValidationError([
          "CalDAV-adres moet HTTPS gebruiken en mag geen inloggegevens bevatten.",
        ]);
    }
    if (
      server === "imap" &&
      submitted.IMAP_HOST &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(
        submitted.IMAP_HOST,
      )
    )
      throw new ValidationError(["IMAP-hostnaam is ongeldig."]);

    const data = this.read();
    const before = Object.fromEntries(
      fields.map((key) => [key, data[server]?.[key] || process.env[key] || ""]),
    );
    const changedFields = clear
      ? fields.filter((key) => Boolean(data[server]?.[key]))
      : fields.filter(
          (key) => submitted[key] && submitted[key] !== before[key],
        );
    if (!changedFields.length) return this.status(server);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_mcp_credentials",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        phase: "attempt",
        arguments: { server, fields: changedFields, clear },
      });
    } catch {
      throw new ValidationError([
        "Auditlog niet beschikbaar; niets opgeslagen.",
      ]);
    }
    if (clear) delete data[server];
    else {
      const next = { ...before };
      for (const key of fields) if (submitted[key]) next[key] = submitted[key];
      if (fields.some((key) => !next[key]))
        throw new ValidationError([
          "Vul alle drie de velden in voordat je deze koppeling opslaat.",
        ]);
      data[server] = next;
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      const dir = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return this.status(server);
  }
}
