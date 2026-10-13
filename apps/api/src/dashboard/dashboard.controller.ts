import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  AlertsResponse,
  OverviewResponse,
  SystemResponse,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import { StateService } from "../core/state/state.service.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { ToolsService } from "../tools/tools.service.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import type { FocusStatus } from "./alerts-feed.service.js";
import { HostMetricsService } from "./host-metrics.service.js";
import { IntegrationsHealth } from "./integrations-health.service.js";
import { OverviewService } from "./overview.service.js";
import { NodeRedHealth } from "./node-red-health.service.js";

const reachable = async (url: string, headers: Record<string, string> = {}) => {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(2500) }))
      .ok;
  } catch {
    return false;
  }
};

@Controller()
export class DashboardController {
  constructor(
    private readonly config: NovaConfig,
    private readonly host: HostMetricsService,
    private readonly overview: OverviewService,
    private readonly alerts: AlertsFeed,
    private readonly integrations: IntegrationsHealth,
    private readonly state: StateService,
    private readonly mqtt: MqttService,
    private readonly memory: SessionMemoryService,
    private readonly routing: RoutingService,
    private readonly tools: ToolsService,
    private readonly nodeRedHealth: NodeRedHealth,
  ) {}

  /** GET /api/system: this machine's load, memory, disk, network and a short history. */
  @Get("system")
  system(): SystemResponse {
    return {
      ...this.host.sample(),
      network: this.host.network,
      history: this.host.history(),
    };
  }

  /** GET /api/overview: what the side panels show. */
  @Get("overview")
  async overviewData(): Promise<OverviewResponse> {
    try {
      return await this.overview.overview();
    } catch {
      throw new ServiceUnavailableException(
        "Overzicht is tijdelijk niet beschikbaar.",
      );
    }
  }

  /** GET /api/alerts?since=N: things NOVA should say unasked. */
  @Get("alerts")
  alertFeed(@Query("since") since?: string): AlertsResponse {
    return this.alerts.recent(Math.max(0, Number(since) || 0));
  }

  /** Reserve each spoken alert for exactly one open screen. */
  @Post("alerts/:seq/claim-speech")
  claimAlertSpeech(@Param("seq") seq: string): { claimed: boolean } {
    return { claimed: this.alerts.claimSpeech(Number(seq)) };
  }

  @Get("focus")
  focusStatus(): FocusStatus {
    return this.alerts.focusStatus();
  }

  @Post("pomodoro/start")
  startWorkBlock(): FocusStatus {
    return this.alerts.startWorkBlock();
  }

  @Post("focus/:minutes/start")
  startFocus(@Param("minutes") minutes: string): FocusStatus {
    const duration = Number(minutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 240)
      throw new BadRequestException(
        "Focusduur moet tussen 5 en 240 minuten liggen.",
      );
    return this.alerts.startFocus(duration);
  }

  @Post("focus/end")
  endFocus(): FocusStatus {
    return this.alerts.endFocus();
  }

  /** GET /api/integrations */
  @Get("integrations")
  integrationReport() {
    return this.integrations.report();
  }

  /** GET /api/health: everything at a glance, for the status line and the admin screens. */
  @Get("health")
  async health() {
    const [nodeRedReport, omniroute, integrations] = await Promise.all([
      this.nodeRedHealth.report(),
      reachable(`${this.config.omniUrl}/models`, {
        authorization: `Bearer ${this.config.omniKey}`,
      }),
      this.integrations.report(),
    ]);
    const nodeRed = nodeRedReport.online;
    this.state.update("nodeRed", {
      connected: nodeRed,
      flowCount: nodeRedReport.flowCount,
      lastError: nodeRedReport.lastError,
      lastErrorAvailable: nodeRedReport.lastErrorAvailable,
    });
    this.state.update("mqtt", { connected: this.mqtt.connected });
    this.state.update("omniroute", { online: omniroute });
    this.state.update("tts", { connected: true });
    const enabled = this.tools.list().filter((tool) => tool.enabled).length;
    return {
      ok: true,
      integrations,
      routing: this.routing.status(),
      service: "nova",
      model: this.config.omniModel,
      defaultLanguage: this.config.defaultLanguage,
      omnirouteConfigured: Boolean(
        this.config.omniKey && this.config.omniModel,
      ),
      nodeRed,
      mqtt: this.mqtt.connected,
      tts: true,
      memory: {
        persistent: this.memory.isHealthy,
        sessions: this.memory.sessionIds().length,
      },
      tools: { available: enabled },
      toolCount: enabled,
      services: {
        ...integrations,
        omniroute: {
          configured: Boolean(this.config.omniKey),
          online: omniroute,
        },
        nodeRed: nodeRedReport,
        mqtt: { online: this.mqtt.connected },
        tts: { online: true },
        memory: { online: this.memory.isHealthy },
      },
      state: this.state.all(),
    };
  }
}
