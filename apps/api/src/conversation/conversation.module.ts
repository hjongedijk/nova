import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TtsModule } from "../tts/tts.module.js";
import { ConversationController } from "./conversation.controller.js";
import { ConversationService } from "./conversation.service.js";
import { ConversationSettingsStore } from "./conversation.settings.js";
import { OmniRouteStt, STT_PORT } from "./stt.js";

/**
 * Real spoken conversations: speech-to-text through OmniRoute, NOVA's chat pipeline, text-to-speech,
 * barge-in and turn-taking, carried over the phone by Asterisk AudioSocket. Off by default.
 * See docs/conversations.md.
 */
@Module({
  imports: [
    ChatModule,
    PlanningModule,
    RoutingModule,
    SettingsModule,
    TtsModule,
  ],
  controllers: [ConversationController],
  providers: [
    ConversationSettingsStore,
    OmniRouteStt,
    { provide: STT_PORT, useExisting: OmniRouteStt },
    ConversationService,
  ],
  exports: [ConversationService, ConversationSettingsStore],
})
export class ConversationModule {}
