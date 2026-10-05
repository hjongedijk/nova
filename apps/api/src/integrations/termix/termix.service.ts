import { NovaConfig } from "../../core/config/nova-config.js";
import { requestJson } from "../../core/http/http-json.js";
import {
  schema,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../../tools/tool.types.js";
import { runDirectSsh, type SshLogin } from "./direct-ssh.js";

interface TermixHost {
  id: number | string;
  name: string;
  ip?: string;
  port?: number;
  username?: string;
  folder?: string | null;
  tags?: string[] | null;
  hostKeyFingerprint?: string;
}

interface TermixLogin extends SshLogin {
  connectionType?: string;
  jumpHosts?: unknown[];
  useSocks5?: boolean;
}

interface SnippetBody {
  id?: number | string;
  error?: string;
  output?: unknown;
  [key: string]: unknown;
}

const clip = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 8000) : value;

/**
 * Termix access: lists the SSH hosts configured there and runs one confirmed command on a host.
 * Commands go through Termix' snippets plugin; when that fails, NOVA runs it over SSH itself with
 * the login Termix holds for that host, and only after the server's key matches the one Termix knows.
 */
@ToolSourceProvider()
export class TermixService implements ToolSource {
  readonly source = "termix";
  constructor(private readonly config: NovaConfig) {}

  private get url() {
    return this.config.termix.url;
  }
  private get apiKey() {
    return this.config.termix.apiKey;
  }
  get configured(): boolean {
    return Boolean(this.url && this.apiKey);
  }
  health() {
    return { configured: this.configured, url: this.url || null };
  }

  definitions(): ToolDefinition[] {
    const enabled = this.configured;
    return [
      {
        name: "termix_status",
        description:
          "Check whether the Termix server is reachable and the NOVA API key is accepted.",
        parameters: schema(),
        risk: "READ_ONLY",
        enabled,
      },
      {
        name: "termix_hosts",
        description:
          "List the SSH hosts configured in Termix (name, address, folder, tags). Read-only; never exposes credentials.",
        parameters: schema(),
        risk: "READ_ONLY",
        enabled,
      },
      {
        name: "termix_run_command",
        description:
          "Run one shell command on a Termix SSH host and return its output. The host is a Termix host name or numeric id from termix_hosts. Always requires user confirmation showing host and command. Prefer read-only diagnostics; never use for destructive commands unless the user explicitly asked for them.",
        parameters: schema({
          host: { type: "string", minLength: 1, maxLength: 100 },
          command: { type: "string", minLength: 1, maxLength: 1000 },
        }),
        risk: "CONFIRM",
        timeoutMs: 45000,
        enabled,
      },
    ];
  }

  private get<T>(path: string, signal?: AbortSignal) {
    return requestJson<T>(this.url + path, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal,
    });
  }
  private send<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    return requestJson<T>(this.url + path, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body,
      signal,
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call?: ToolCall,
  ): Promise<ToolResult> {
    const signal = call?.signal;
    if (name === "termix_run_command")
      return this.run(String(args.host), String(args.command), signal);
    if (name === "termix_status") {
      const [health, me] = await Promise.all([
        requestJson(`${this.url}/health`, { signal }),
        this.get("/users/me", signal),
      ]);
      return {
        ok: health.status === 200 && me.status === 200,
        result: {
          reachable: health.status === 200,
          keyAccepted: me.status === 200,
        },
      };
    }
    if (name === "termix_hosts") {
      const response = await this.get<TermixHost[]>("/host/db/host", signal);
      if (response.status !== 200 || !Array.isArray(response.data))
        return {
          ok: false,
          error: `Termix host list unavailable (${response.status})`,
        };
      return {
        ok: true,
        result: response.data.slice(0, 200).map((host) => ({
          id: host.id,
          name: host.name,
          ip: host.ip,
          port: host.port,
          username: host.username,
          folder: host.folder,
          tags: host.tags,
        })),
      };
    }
    return { ok: false, error: "Unknown Termix tool" };
  }

  private async run(
    hostRef: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const list = await this.get<TermixHost[]>("/host/db/host", signal);
    if (list.status !== 200 || !Array.isArray(list.data))
      return {
        ok: false,
        error: `Termix host list unavailable (${list.status})`,
      };
    const wanted = hostRef.toLowerCase().trim();
    const exact = list.data.filter(
      (host) =>
        String(host.id) === wanted ||
        String(host.name).toLowerCase() === wanted,
    );
    // Fall back to a whole-word match so "vm100" finds "debian-hu697d - VM100".
    const word = new RegExp(
      `(^|[^a-z0-9])${wanted.replace(/[^a-z0-9]/g, "\\$&")}($|[^a-z0-9])`,
      "i",
    );
    const matches = exact.length
      ? exact
      : list.data.filter((host) => word.test(String(host.name)));
    const host = matches[0];
    if (matches.length !== 1 || !host)
      return {
        ok: false,
        error: matches.length
          ? "Host name is ambiguous; use the id"
          : "Unknown Termix host",
      };
    const viaTermix = await this.runSnippet(host, command, signal);
    if (viaTermix.ok) return viaTermix;
    const direct = await this.runSsh(host, command, signal);
    if (direct.ok)
      return {
        ...direct,
        result: {
          ...(direct.result as object),
          note: `Termix kon het zelf niet uitvoeren (${viaTermix.error}), dus NOVA deed het rechtstreeks over SSH.`,
        },
      };
    return {
      ok: false,
      error: `${viaTermix.error} Rechtstreeks over SSH lukte ook niet: ${direct.error}`,
    };
  }

  /** Why Termix could not connect, from its own audit log. */
  private async lastConnectError(
    hostId: number | string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const response = await this.get<{
        logs?: {
          action: string;
          details: string;
          success: boolean;
          errorMessage?: string;
        }[];
      }>("/audit-logs?limit=20", signal);
      const entry = (response.data?.logs ?? []).find(
        (log) =>
          /ssh_connect/.test(log.action) &&
          log.details === `host ${hostId}` &&
          log.success === false,
      );
      return entry?.errorMessage || null;
    } catch {
      return null;
    }
  }

  /**
   * Termix has no raw-exec endpoint; the snippets plugin runs a saved command on a host.
   * A throwaway snippet is created, executed and always deleted.
   */
  private async runSnippet(
    host: TermixHost,
    command: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const created = await this.send<SnippetBody>(
      "POST",
      "/plugin-api/snippets",
      {
        name: `jarvis-${Date.now()}`,
        content: command,
        description: "Temporary NOVA command",
      },
      signal,
    );
    const snippetId = created.data?.id;
    if (created.status !== 201 || snippetId === undefined)
      return {
        ok: false,
        error: `Termix snippet creation failed (${created.status})`,
      };
    try {
      const run = await this.send<SnippetBody>(
        "POST",
        "/plugin-api/snippets/execute",
        { snippetId, hostId: host.id },
        signal,
      );
      if (run.status !== 200) {
        const reason = await this.lastConnectError(host.id, signal);
        return {
          ok: false,
          error: reason
            ? /authentication methods failed/i.test(reason)
              ? `Termix kon niet inloggen op ${host.name}: de server weigerde de login.`
              : `Termix kon geen verbinding maken met ${host.name}: ${reason}.`
            : run.data?.error || `Termix execution failed (${run.status})`,
        };
      }
      return {
        ok: true,
        verified: null,
        result: {
          host: host.name,
          via: "termix",
          ...run.data,
          output: clip(run.data?.output),
          error: clip(run.data?.error),
        },
      };
    } finally {
      await this.send(
        "DELETE",
        `/plugin-api/snippets/${encodeURIComponent(String(snippetId))}`,
      ).catch(() => {});
    }
  }

  /** The same command over SSH, with the login Termix keeps for this host. */
  private async runSsh(
    host: TermixHost,
    command: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const fingerprint = String(host.hostKeyFingerprint || "").trim();
    if (!fingerprint)
      return {
        ok: false,
        error:
          "Termix kent de sleutel van deze server nog niet, dus NOVA kan niet controleren dat het de juiste server is. Maak één keer verbinding via Termix.",
      };
    const exported = await this.get<TermixLogin>(
      `/host/db/host/${encodeURIComponent(String(host.id))}/export`,
      signal,
    );
    const login = exported.data;
    if (exported.status !== 200 || !login?.ip)
      return {
        ok: false,
        error: `Termix gaf de login van deze host niet (${exported.status}).`,
      };
    if ((login.connectionType || "ssh") !== "ssh")
      return { ok: false, error: "Dit is geen SSH-host." };
    if (
      (Array.isArray(login.jumpHosts) && login.jumpHosts.length) ||
      login.useSocks5
    )
      return {
        ok: false,
        error:
          "Deze host gaat via een jump host of proxy; dat kan alleen via Termix zelf.",
      };
    if (!login.password && !login.key)
      return {
        ok: false,
        error: "Termix heeft geen wachtwoord of sleutel voor deze host.",
      };
    const outcome = await runDirectSsh(login, command, fingerprint, signal);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return {
      ok: true,
      verified: null,
      result: { host: host.name, via: "ssh", ...outcome.result },
    };
  }
}
