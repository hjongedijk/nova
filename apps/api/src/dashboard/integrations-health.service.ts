import { Injectable } from "@nestjs/common";
import { ChecksService } from "../checks/checks.service.js";
import { StateService } from "../core/state/state.service.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { BrowserAgentService } from "../integrations/browser-agent/browser-agent.service.js";
import { McpHub } from "../integrations/mcp/mcp.hub.js";
import { PangolinService } from "../integrations/pangolin/pangolin.service.js";
import { TermixService } from "../integrations/termix/termix.service.js";
import { WindowsPcService } from "../integrations/windows/windows-pc.service.js";
import { WorldService } from "../integrations/world/world.service.js";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { NovaConfig } from "../core/config/nova-config.js";

/** What /api/integrations and the system_integrations tool report: who is configured and reachable. */
@Injectable()
export class IntegrationsHealth {
  constructor(
    private readonly config: NovaConfig,
    private readonly state: StateService,
    private readonly home: HomeAssistantService,
    private readonly semantic: SemanticMemoryService,
    private readonly windows: WindowsPcService,
    private readonly termix: TermixService,
    private readonly pangolin: PangolinService,
    private readonly mcp: McpHub,
    private readonly world: WorldService,
    private readonly browser: BrowserAgentService,
    private readonly routing: RoutingService,
    private readonly checks: ChecksService,
  ) {}

  /** Health of the integrations as the tool reports it to the model. */
  async forTool() {
    return {
      homeAssistant: this.home.health(),
      memory: await this.semantic.health(),
      windows: this.windows.health(),
      termix: this.termix.health(),
      pangolin: this.pangolin.health(),
      mcp: this.mcp.health(),
      world: this.world.health(),
      browser: this.browser.health(),
    };
  }

  /** GET /api/integrations. The checks run side by side: the slowest one sets the pace. */
  async report() {
    const state = this.state.all();
    const [homeAssistant, qdrant, longTermMemory] = await Promise.all([
      this.homeHealth(),
      this.semantic.qdrantHealth(),
      this.semantic.health(),
    ]);
    return {
      homeAssistant,
      proxmox: {
        online: state.proxmox?.online === true && !state.proxmox.stale,
        updatedAt: state.proxmox?.updatedAt ?? null,
      },
      mqtt: { online: state.mqtt?.connected === true },
      tts: { online: true },
      shortTermMemory: { online: state.memory?.online !== false },
      omniroute: {
        configured: Boolean(this.config.omniKey),
        online: state.omniroute?.online === true,
      },
      qdrant,
      longTermMemory,
      actions: {
        enabled: this.config.actionsEnabled,
        safeAutomatic: this.config.autoExecuteSafe,
      },
      routing: this.routing.status(),
    };
  }

  private async homeHealth() {
    if (this.home.configured) {
      try {
        await this.home.sync();
      } catch {
        /* the cached failure is what gets reported */
      }
    }
    return this.home.health();
  }
}
