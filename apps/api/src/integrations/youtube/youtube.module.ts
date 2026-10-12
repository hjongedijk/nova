import { Module } from "@nestjs/common";
import { YoutubeService } from "./youtube.service.js";
import { YoutubeOAuthService } from "./youtube-oauth.service.js";
import { YoutubeOAuthController } from "./youtube-oauth.controller.js";
import { YoutubeCaptionsSource } from "./youtube-captions.source.js";
import { SettingsGuard } from "../../settings/settings.guard.js";

@Module({
  controllers: [YoutubeOAuthController],
  providers: [
    YoutubeService,
    YoutubeOAuthService,
    YoutubeCaptionsSource,
    SettingsGuard,
  ],
  exports: [YoutubeService, YoutubeOAuthService],
})
export class YoutubeModule {}
