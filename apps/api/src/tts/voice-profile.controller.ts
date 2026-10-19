import { Body, Controller, Get, Header, Put } from "@nestjs/common";
import { VoiceProfileStore } from "./voice-profile.store.js";

/** Settings > Stem: the voice used for phone calls and spoken conversations. */
@Controller("settings/voice-profile")
export class VoiceProfileController {
  constructor(private readonly store: VoiceProfileStore) {}

  @Get()
  @Header("Cache-Control", "no-store")
  read() {
    return { ...this.store.get(), initialized: this.store.initialized };
  }

  @Put()
  update(@Body() body: unknown) {
    if (
      body &&
      typeof body === "object" &&
      "initialize" in body &&
      body.initialize === true &&
      this.store.initialized
    )
      return this.read();
    return { ...this.store.set(body), initialized: true };
  }
}
