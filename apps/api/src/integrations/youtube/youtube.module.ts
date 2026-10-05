import { Module } from "@nestjs/common";
import { YoutubeService } from "./youtube.service.js";

@Module({ providers: [YoutubeService], exports: [YoutubeService] })
export class YoutubeModule {}
