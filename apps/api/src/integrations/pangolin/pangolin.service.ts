import { NovaConfig } from "../../core/config/nova-config.js";
import { requestJson } from "../../core/http/http-json.js";
import {
  schema,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
  type ToolCall,
} from "../../tools/tool.types.js";

interface PangolinBody {
  message?: string;
  data?: unknown;
}

/**
 * Read-only Pangolin Integration API access (sites and public resources).
 * PANGOLIN_URL may be an IP address; PANGOLIN_HOST is then sent as Host/SNI,
 * which is how the Traefik instance on the LAN routes requests.
 */
@ToolSourceProvider()
export class PangolinService implements ToolSource {
  readonly source = "pangolin";
  constructor(private readonly config: NovaConfig) {}

  private get settings() {
    return this.config.pangolin;
  }
  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.apiKey);
  }
  health() {
    return {
      configured: this.configured,
      url: this.settings.url || null,
      organization: this.settings.orgId || null,
    };
  }

  definitions(): ToolDefinition[] {
    const enabled = this.configured;
    const org = {
      orgId: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        pattern: "^[A-Za-z0-9_-]+$",
      },
    };
    return [
      {
        name: "pangolin_orgs",
        description: "List Pangolin organizations visible to the NOVA API key.",
        parameters: schema(),
        risk: "READ_ONLY",
        enabled,
      },
      {
        name: "pangolin_sites",
        description:
          "List Pangolin sites (tunnels) and whether they are online. Defaults to the configured organization.",
        parameters: schema(org, []),
        risk: "READ_ONLY",
        enabled,
      },
      {
        name: "pangolin_resources",
        description:
          "List Pangolin public resources (published services) and their domains. Defaults to the configured organization.",
        parameters: schema(org, []),
        risk: "READ_ONLY",
        enabled,
      },
    ];
  }

  private get(path: string, signal?: AbortSignal) {
    return requestJson<PangolinBody>(this.settings.url + path, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      hostHeader: this.settings.host || undefined,
      insecureTls: this.settings.insecureTls,
      signal,
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call?: ToolCall,
  ): Promise<ToolResult> {
    if (
      !["pangolin_orgs", "pangolin_sites", "pangolin_resources"].includes(name)
    )
      return { ok: false, error: "Unknown Pangolin tool" };
    const orgId = (args.orgId as string | undefined) || this.settings.orgId;
    const path =
      name === "pangolin_orgs"
        ? "/orgs"
        : orgId
          ? `/org/${encodeURIComponent(orgId)}/${name === "pangolin_sites" ? "sites" : "resources"}`
          : null;
    if (!path)
      return {
        ok: false,
        error: "No organization configured; call pangolin_orgs first",
      };
    const response = await this.get(path, call?.signal);
    if (response.status !== 200)
      return {
        ok: false,
        error: response.data?.message || `Pangolin error (${response.status})`,
      };
    return { ok: true, result: response.data?.data ?? response.data };
  }
}
