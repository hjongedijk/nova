import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { TtsService } from "./tts.service.js";

@Controller("tts")
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  /** POST /api/tts { text } -> audio/mpeg */
  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async speak(
    @Body() body: { text?: unknown },
    @Res() response: Response,
  ): Promise<void> {
    const { audio, cached } = await this.tts.speak(body?.text);
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(audio.length));
    if (cached) response.setHeader("X-TTS-Cache", "hit");
    response.end(audio);
  }

  /** GET /api/tts/health */
  @Get("health")
  health() {
    return this.tts.health();
  }
}
