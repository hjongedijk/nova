import {
  schema,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { LanDiscoveryService } from "./lan-discovery.service.js";
import { proposalText } from "./lan-discovery.js";

/** lan_discover: what is on the owner's own network (Home Assistant, Proxmox, ...). Read-only, rate limited. */
@ToolSourceProvider()
export class LanDiscoverySource implements ToolSource {
  readonly source = "lan-discovery";
  constructor(private readonly discovery: LanDiscoveryService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "lan_discover",
        description:
          "Look for known services on the user's own home network (Home Assistant, Proxmox, Node-RED, MQTT, OmniRoute, Qdrant, Grafana): 'wat staat er op mijn netwerk', 'zoek apparaten', 'vind Home Assistant'. Read-only: only private LAN addresses, nothing is changed or connected. Returns what was found with a proposal; to connect an API without login use api_connect with the url and local_network=true, for anything with a login ask the user for their own key (never invent credentials). rescan=true scans again (rate limited).",
        parameters: schema({ rescan: { type: "boolean" } }, []),
        risk: "READ_ONLY",
        timeoutMs: 45_000,
      },
    ];
  }

  async execute(
    _name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolResult> {
    const outcome = await this.discovery.scan(
      args.rescan === true ? undefined : 24 * 60 * 60_000,
      call.signal,
    );
    const found = outcome.candidates.filter((c) => c.state !== "dismissed");
    return {
      ok: true,
      result: {
        scanned: outcome.scanned,
        found: found.map((c) => ({
          name: c.name,
          host: c.host,
          port: c.port,
          url: c.url,
          login: c.auth,
          connected: c.state === "connected",
          proposal: proposalText(c).detail,
        })),
      },
      hint: found.length
        ? "Tell the user in one short line what was found and ask whether to connect it. Do not claim anything is connected. Never invent credentials."
        : "Nothing recognisable was found. Say so plainly.",
    };
  }
}
