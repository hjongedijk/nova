import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AppAccessPublic } from "../../access/access-public.js";
import { NovaConfig } from "../../core/config/nova-config.js";
import { matchesNodeRedToken } from "../../dashboard/node-red-token.js";
import { AutonomyService } from "./autonomy.service.js";
import { describeTask } from "./autonomy.source.js";

const EVENT = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

/** App-guarded management API plus a token-guarded trigger for Node-RED (MQTT, Home Assistant, ...). */
@Controller()
export class AutonomyController {
  private windowStartedAt = Date.now();
  private accepted = 0;
  constructor(
    private readonly autonomy: AutonomyService,
    private readonly config: NovaConfig,
  ) {}

  @Get("autonomy/tasks")
  list() {
    return { tasks: this.autonomy.list().map(describeTask) };
  }

  @Post("autonomy/tasks/:id/approve")
  @HttpCode(200)
  approve(@Param("id") id: string) {
    const approvedSteps = this.autonomy.approve(id);
    if (!approvedSteps.length)
      throw new NotFoundException("Geen wachtende stap");
    return { approvedSteps };
  }

  @Delete("autonomy/tasks/:id")
  cancel(@Param("id") id: string) {
    if (!this.autonomy.cancel(id))
      throw new NotFoundException("Taak niet gevonden");
    return { cancelled: true };
  }

  /** Node-RED forwards an event name; tasks that listen for it start a run. Bounded and idempotent per eventId. */
  @Post("integrations/node-red/trigger")
  @AppAccessPublic()
  @HttpCode(202)
  trigger(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { event?: unknown; eventId?: unknown },
  ) {
    const expected = this.config.nodeRedEventToken;
    if (expected.length < 32)
      throw new ServiceUnavailableException(
        "Node-RED event ingress is not configured",
      );
    if (!matchesNodeRedToken(authorization, expected))
      throw new UnauthorizedException();
    const now = Date.now();
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.accepted = 0;
    }
    if (++this.accepted > 30)
      throw new HttpException(
        "Too many triggers",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (typeof body?.event !== "string" || !EVENT.test(body.event))
      throw new BadRequestException("Invalid event name");
    if (
      body.eventId !== undefined &&
      (typeof body.eventId !== "string" ||
        !/^[\w.:-]{1,80}$/.test(body.eventId))
    )
      throw new BadRequestException("Invalid event id");
    return this.autonomy.fireEvent(
      body.event,
      body.eventId as string | undefined,
    );
  }
}
