import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "../settings/settings.guard.js";
import { AutopilotService } from "./autopilot.service.js";
import { AutopilotError } from "./autopilot.types.js";

/** Visible proof: what the autopilot did, found and sent. App-guarded like the rest of the API. */
@Controller("autopilot")
export class AutopilotController {
  constructor(private readonly autopilot: AutopilotService) {}

  @Get("status")
  status() {
    return this.autopilot.status();
  }

  @Get("activity")
  activity() {
    return { activity: this.autopilot.activity() };
  }

  /** Run one round now (read-only scans, the same gates apply). */
  @Post("scan")
  @HttpCode(200)
  async scan() {
    const result = await this.autopilot.scan();
    return { ...result, status: this.autopilot.status() };
  }
}

/** The autopilot settings, for the settings screen to follow later. Also the REST kill switch: PUT {"enabled": false}. */
@Controller("settings/autopilot")
@UseGuards(SettingsGuard)
export class AutopilotSettingsController {
  constructor(private readonly autopilot: AutopilotService) {}

  @Get()
  get() {
    return { settings: this.autopilot.settings };
  }

  @Put()
  @HttpCode(200)
  put(@Body() body: unknown) {
    try {
      return { settings: this.autopilot.updateSettings(body) };
    } catch (error) {
      if (error instanceof AutopilotError)
        throw new ValidationError([error.message]);
      throw error;
    }
  }
}
