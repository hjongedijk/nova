import { Module } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { ConversationModule } from "../conversation/conversation.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { TtsModule } from "../tts/tts.module.js";
import { AriHttpClient, validateAriUrl } from "./ari.client.js";
import { TelephonyController } from "./telephony.controller.js";
import { TelephonyService } from "./telephony.service.js";
import { TelephonySource } from "./telephony.source.js";
import { TelephonyStore } from "./telephony.store.js";
import { ARI_PORT } from "./telephony.types.js";

/**
 * Telephony: Asterisk (self-hosted SIP PBX) controlled over ARI. Off by default; NOVA only talks to
 * Asterisk when the user switches it on in the settings.
 */
@Module({
  imports: [PlanningModule, TtsModule, ConversationModule],
  controllers: [TelephonyController],
  providers: [
    TelephonyStore,
    {
      provide: ARI_PORT,
      inject: [TelephonyStore, NovaConfig],
      useFactory: (store: TelephonyStore) =>
        new AriHttpClient(
          validateAriUrl(
            process.env.NOVA_ASTERISK_ARI_URL?.trim() ||
              "http://127.0.0.1:8088",
          ),
          () => store.get().ariSecret,
        ),
    },
    TelephonyService,
    TelephonySource,
  ],
  exports: [TelephonyService],
})
export class TelephonyModule {}
