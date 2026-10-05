import { Module } from "@nestjs/common";
import { ConfirmationsModule } from "../confirmations/confirmations.module.js";
import { HomeModule } from "../home/home.module.js";
import { MemoryModule } from "../memory/memory.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ChatController } from "./chat.controller.js";
import { ConfirmationHandler } from "./confirmation-handler.service.js";
import { ContextBuilder } from "./context-builder.service.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { OutcomeService } from "./outcome.service.js";

/**
 * Conversation: /api/chat, /api/chat-stream and /api/actions/confirm. It talks to the language model
 * through OmniRoute (the client lives in BridgesModule, which also lends it to the settings screen),
 * and runs the tools the model asks for.
 */
@Module({
  imports: [
    ConfirmationsModule,
    HomeModule,
    MemoryModule,
    RoutingModule,
    SettingsModule,
  ],
  controllers: [ChatController],
  providers: [
    OrchestratorService,
    ContextBuilder,
    ConfirmationHandler,
    OutcomeService,
  ],
  exports: [OrchestratorService],
})
export class ChatModule {}
