import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { ObjectivesService } from "./objectives.service.js";
import { describeObjective } from "./objectives.source.js";
import { ObjectiveError } from "./objectives.types.js";

const ID = /^[0-9a-f]{8}$/;

/** App-guarded management of standing objectives for the UI (the same operations as the objective_* tools). */
@Controller("objectives")
export class ObjectivesController {
  constructor(private readonly objectives: ObjectivesService) {}

  @Get()
  list() {
    const now = this.objectives.now();
    return {
      objectives: this.objectives.list().map((o) => describeObjective(o, now)),
    };
  }

  @Put(":id")
  @HttpCode(200)
  update(
    @Param("id") id: string,
    @Body()
    body: {
      title?: unknown;
      intervalMinutes?: unknown;
      cooldownMinutes?: unknown;
      quietHours?: unknown;
      expiresInDays?: unknown;
      enabled?: unknown;
      dismiss?: unknown;
    },
  ) {
    return this.guard(() =>
      describeObjective(
        this.objectives.update(this.id(id), {
          title: body?.title,
          intervalMinutes: body?.intervalMinutes,
          cooldownMinutes: body?.cooldownMinutes,
          quietHours: body?.quietHours,
          expiresInDays: body?.expiresInDays,
          enabled: body?.enabled,
          dismiss: body?.dismiss,
        }),
        this.objectives.now(),
      ),
    );
  }

  @Delete(":id")
  @HttpCode(200)
  remove(@Param("id") id: string) {
    return this.guard(() => {
      this.objectives.remove(this.id(id));
      return { deleted: true };
    });
  }

  private id(id: string): string {
    if (!ID.test(id)) throw new ValidationError(["Ongeldig doel."]);
    return id;
  }
  private guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof ObjectiveError)
        throw new ValidationError([error.message]);
      throw error;
    }
  }
}
