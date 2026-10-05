import { Module } from "@nestjs/common";
import { YoutubeModule } from "../youtube/youtube.module.js";
import { WindowsPcService } from "./windows-pc.service.js";
import { WindowsTools } from "./windows.tools.js";

@Module({
  imports: [YoutubeModule],
  providers: [WindowsPcService, WindowsTools],
  exports: [WindowsPcService],
})
export class WindowsModule {}
