import { Module } from "@nestjs/common";
import { TtsController } from "./tts.controller.js";
import { TtsService } from "./tts.service.js";
import { VoiceProfileController } from "./voice-profile.controller.js";
import { VoiceProfileStore } from "./voice-profile.store.js";

/** Speech: edge-tts in Node, so NOVA needs no separate Python service. */
@Module({
  controllers: [TtsController, VoiceProfileController],
  providers: [TtsService, VoiceProfileStore],
  exports: [TtsService, VoiceProfileStore],
})
export class TtsModule {}
