import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
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

  /** The owner's reaction to a nudge (the app calls this when one is dismissed or acted on); steers self-tuning. */
  @Post("reaction")
  @HttpCode(200)
  reaction(@Body() body: unknown) {
    const b = (typeof body === "object" && body ? body : {}) as Record<
      string,
      unknown
    >;
    const reaction = b.reaction;
    if (
      reaction !== "dismissed" &&
      reaction !== "acted" &&
      reaction !== "stopped"
    )
      throw new ValidationError(["reaction: dismissed, acted of stopped"]);
    const id = typeof b.id === "string" ? b.id.slice(0, 40) : undefined;
    const key = typeof b.key === "string" ? b.key.slice(0, 200) : undefined;
    return this.autopilot.react({ id, key }, reaction);
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
