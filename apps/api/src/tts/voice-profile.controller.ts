import { Body, Controller, Get, Header, Put, UseGuards } from "@nestjs/common";
import { SettingsGuard } from "../settings/settings.guard.js";
import { VoiceProfileStore } from "./voice-profile.store.js";

/** Settings > Stem: the voice used for phone calls and spoken conversations. Behind the settings guard. */
@Controller("settings/voice-profile")
@UseGuards(SettingsGuard)
export class VoiceProfileController {
  constructor(private readonly store: VoiceProfileStore) {}

  @Get()
  @Header("Cache-Control", "no-store")
  read() {
    return this.store.get();
  }

  @Put()
  update(@Body() body: unknown) {
    return this.store.set(body);
  }
}
