import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { PlanningService } from "./planning.service.js";

@Controller("cooking")
export class CookingController {
  constructor(private readonly planning: PlanningService) {}

  /** Use the same persisted timer and alert path as the timer_set tool. */
  @Post("timer")
  setStepTimer(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new BadRequestException("Ongeldige kooktimer.");
    const { minutes, step } = body as Record<string, unknown>;
    if (
      !Number.isInteger(minutes) ||
      (minutes as number) < 1 ||
      (minutes as number) > 240 ||
      !Number.isInteger(step) ||
      (step as number) < 1 ||
      (step as number) > 30
    )
      throw new BadRequestException("Kies een stap en 1 tot 240 minuten.");
    return this.planning.setTimer({
      seconds: (minutes as number) * 60,
      label: `Kookstap ${step}`,
    });
  }
}
