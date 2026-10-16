import { Global, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { ConfirmationsModule } from "../confirmations/confirmations.module.js";
import { MemoryModule } from "../memory/memory.module.js";
import { SettingsStoreModule } from "../settings/store/settings-store.module.js";
import { AutonomyLevelStore } from "./autonomy-level.store.js";
import { ToolsController } from "./tools.controller.js";
import { ToolsService } from "./tools.service.js";
import { ToolCatalogSource } from "./tool-catalog.source.js";

/**
 * The tool registry and executor. Sources of tools live in their own modules and are found
 * through @ToolSourceProvider(). Global, so the chat and dashboard can run tools.
 */
@Global()
@Module({
  imports: [
    DiscoveryModule,
    ConfirmationsModule,
    MemoryModule,
    SettingsStoreModule,
  ],
  controllers: [ToolsController],
  providers: [ToolsService, ToolCatalogSource, AutonomyLevelStore],
  exports: [
    ToolsService,
    AutonomyLevelStore,
    ConfirmationsModule,
    MemoryModule,
    SettingsStoreModule,
  ],
})
export class ToolsModule {}
