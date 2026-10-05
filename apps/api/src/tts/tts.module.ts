import { Module } from "@nestjs/common";
import { TtsController } from "./tts.controller.js";
import { TtsService } from "./tts.service.js";

/** Speech: edge-tts in Node, so NOVA needs no separate Python service. */
@Module({
  controllers: [TtsController],
  providers: [TtsService],
  exports: [TtsService],
})
export class TtsModule {}
