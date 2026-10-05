import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import fs from "node:fs";
import { BridgesModule } from "./bridges/bridges.module.js";
import { ChatModule } from "./chat/chat.module.js";
import { ChecksModule } from "./checks/checks.module.js";
import { ConfirmationsModule } from "./confirmations/confirmations.module.js";
import { NovaConfig } from "./core/config/nova-config.js";
import { CoreModule } from "./core/core.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { DownloadsModule } from "./downloads/downloads.module.js";
import { HealthModule } from "./health/health.module.js";
import { HomeModule } from "./home/home.module.js";
import { BrowserAgentModule } from "./integrations/browser-agent/browser-agent.module.js";
import { McpModule } from "./integrations/mcp/mcp.module.js";
import { PangolinModule } from "./integrations/pangolin/pangolin.module.js";
import { TermixModule } from "./integrations/termix/termix.module.js";
import { WindowsModule } from "./integrations/windows/windows.module.js";
import { WorldModule } from "./integrations/world/world.module.js";
import { MemoryModule } from "./memory/memory.module.js";
import { PlanningModule } from "./planning/planning.module.js";
import { ProxmoxModule } from "./proxmox/proxmox.module.js";
import { RoutingModule } from "./routing/routing.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { ToolsModule } from "./tools/tools.module.js";
import { TtsModule } from "./tts/tts.module.js";

const config = new NovaConfig();

/**
 * NOVA: one module per domain. Tool sources (Proxmox, planning, checks, Home Assistant, world, MCP,
 * Termix, Pangolin, Windows, browser, memory, skills, OmniRoute, system) register themselves with
 * ToolsModule; nothing here lists tools.
 */
@Module({
  imports: [
    CoreModule,
    HealthModule,
    ToolsModule,
    ConfirmationsModule,
    MemoryModule,
    RoutingModule,
    SettingsModule,
    ChatModule,
    DashboardModule,
    TtsModule,
    DownloadsModule,
    ProxmoxModule,
    PlanningModule,
    ChecksModule,
    HomeModule,
    WorldModule,
    McpModule,
    TermixModule,
    PangolinModule,
    WindowsModule,
    BrowserAgentModule,
    BridgesModule,
    // In production the built Svelte app is served from here; while developing, Vite serves it.
    ...(fs.existsSync(config.webDir)
      ? [
          ServeStaticModule.forRoot({
            rootPath: config.webDir,
            exclude: ["/api/{*path}"],
          }),
        ]
      : []),
  ],
})
export class AppModule {}
