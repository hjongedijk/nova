import { NovaConfig } from "../../core/config/nova-config.js";
import { Optional } from "@nestjs/common";
import { requestJson } from "../../core/http/http-json.js";
import { ManagedTargetsAccessStore } from "../../settings/managed-targets-access.store.js";
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

const COLLECTIONS = {
  pangolin_orgs: {
    key: "orgs",
    ids: ["id", "orgId"],
    fields: ["name", "slug", "niceId"],
  },
  pangolin_sites: {
    key: "sites",
    ids: ["id", "siteId"],
    fields: ["name", "niceId", "type", "online"],
  },
  pangolin_resources: {
    key: "resources",
    ids: ["id", "resourceId", "siteResourceId"],
    fields: [
      "name",
      "niceId",
      "fullDomain",
      "subdomain",
      "domain",
      "type",
      "protocol",
      "online",
      "enabled",
      "http",
    ],
  },
} as const;

function projectCollection(
  name: keyof typeof COLLECTIONS,
  value: unknown,
): unknown {
  const { key, ids, fields } = COLLECTIONS[name];
  const envelope =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const raw = Array.isArray(value) ? value : envelope?.[key];
  if (!Array.isArray(raw)) return null;
  const rows = raw.slice(0, 200).flatMap((item): Record<string, unknown>[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    const id = ids
      .map((field) => source[field])
      .find(
        (entry) =>
          (typeof entry === "string" &&
            /^[A-Za-z0-9_.-]{1,100}$/.test(entry)) ||
          (typeof entry === "number" &&
            Number.isSafeInteger(entry) &&
            entry >= 0),
      );
    if (id === undefined) return [];
    row.id = id;
    for (const field of fields) {
      const data = source[field];
      if (typeof data === "string" && data.length <= 255) row[field] = data;
      else if (
        typeof data === "boolean" ||
        (typeof data === "number" && Number.isFinite(data))
      )
        row[field] = data;
    }
    return [row];
  });
  return Array.isArray(value) ? rows : { [key]: rows };
}

/**
 * Read-only Pangolin Integration API access (sites and public resources).
 * PANGOLIN_URL may be an IP address; PANGOLIN_HOST is then sent as Host/SNI,
 * which is how the Traefik instance on the LAN routes requests.
 */
@ToolSourceProvider()
export class PangolinService implements ToolSource {
  readonly source = "pangolin";
  constructor(
    private readonly config: NovaConfig,
    @Optional() private readonly targetAccess?: ManagedTargetsAccessStore,
  ) {}

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

  /** Raw configured-organization target inventory for the guarded Settings editor. */
  async listTargets(
    name: "pangolin_sites" | "pangolin_resources",
    signal?: AbortSignal,
  ): Promise<unknown> {
    const orgId = this.settings.orgId;
    if (!orgId) throw new Error("Pangolin organization is not configured");
    const response = await this.get(
      `/org/${encodeURIComponent(orgId)}/${name === "pangolin_sites" ? "sites" : "resources"}`,
      signal,
    );
    if (response.status !== 200 || response.data?.data === undefined)
      throw new Error(`Pangolin response unavailable (${response.status})`);
    const projected = projectCollection(name, response.data.data);
    if (projected === null) throw new Error("Pangolin response unavailable");
    return projected;
  }

  private filteredTargets(
    value: unknown,
    key: "pangolinSiteIds" | "pangolinResourceIds",
  ) {
    if (this.targetAccess?.get().mode !== "allowlist") return value;
    const property = key === "pangolinSiteIds" ? "sites" : "resources";
    const rows = Array.isArray(value)
      ? value
      : value &&
          typeof value === "object" &&
          Array.isArray((value as Record<string, unknown>)[property])
        ? ((value as Record<string, unknown>)[property] as unknown[])
        : null;
    if (!rows) return value;
    const allowed = rows.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const id = (item as Record<string, unknown>).id;
      return (
        id !== undefined &&
        (this.targetAccess?.allows(key, String(id)) ?? false)
      );
    });
    return Array.isArray(value)
      ? allowed
      : { ...(value as Record<string, unknown>), [property]: allowed };
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
    if (
      this.targetAccess?.get().mode === "allowlist" &&
      orgId !== this.settings.orgId
    )
      return {
        ok: false,
        error: "Pangolin organization is not available to NOVA",
      };
    if (
      name === "pangolin_orgs" &&
      this.targetAccess?.get().mode === "allowlist"
    )
      return { ok: true, result: [] };
    if (name === "pangolin_sites" || name === "pangolin_resources") {
      try {
        const key =
          name === "pangolin_sites" ? "pangolinSiteIds" : "pangolinResourceIds";
        return {
          ok: true,
          result: this.filteredTargets(
            await this.listTargets(name, call?.signal),
            key,
          ),
        };
      } catch {
        return {
          ok: false,
          error:
            "Pangolin request failed. Check the connection and configuration.",
        };
      }
    }
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
        error: `Pangolin error (${response.status})`,
      };
    if (response.data?.data === undefined)
      return { ok: false, error: "Pangolin response unavailable" };
    const projected = projectCollection("pangolin_orgs", response.data.data);
    if (projected === null)
      return { ok: false, error: "Pangolin response unavailable" };
    return { ok: true, result: projected };
  }
}
