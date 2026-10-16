import { Body, Controller, Get, Header, Put, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "../settings/settings.guard.js";
import { AUTONOMY_LEVELS, isAutonomyLevel } from "../tools/autonomy-policy.js";
import { AutonomyLevelStore } from "../tools/autonomy-level.store.js";

/** Settings > Zelfstandige taken: how much NOVA does without asking. Behind the settings PIN. */
@Controller("settings/autonomy-level")
@UseGuards(SettingsGuard)
export class AutonomyLevelController {
  constructor(private readonly store: AutonomyLevelStore) {}

  @Get()
  @Header("Cache-Control", "no-store")
  read() {
    return { level: this.store.get(), levels: AUTONOMY_LEVELS };
  }

  @Put()
  update(@Body() body: { level?: unknown }) {
    if (!isAutonomyLevel(body?.level))
      throw new ValidationError([
        "Kies voorzichtig, gebalanceerd of zelfstandig.",
      ]);
    return { level: this.store.set(body.level), levels: AUTONOMY_LEVELS };
  }
}
