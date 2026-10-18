import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { NativePromptService } from "./native-prompt.service.js";
@Controller("settings/omniroute/native/prompt")
export class NativePromptController {
  constructor(private readonly prompt: NativePromptService) {}
  @Get("history") history() {
    return this.prompt.history();
  }
  @Post() @HttpCode(200) replace(@Body() body: unknown) {
    return this.prompt.replace(body);
  }
}
