import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { AgentService } from "./agent.service.js";
import { describeRun } from "./agent.source.js";
import { AgentError } from "./agent.types.js";

const ID = /^[0-9a-f]{8}$/;

/** App-guarded management of background goals (the same operations as the agent_* tools). */
@Controller("agent")
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Get("runs")
  list() {
    return {
      runs: this.agent
        .list()
        .map((run) => ({ ...describeRun(run), log: run.log.slice(-12) })),
    };
  }

  @Post("runs")
  @HttpCode(201)
  start(@Body() body: { goal?: unknown; maxMinutes?: unknown }) {
    return this.guard(() =>
      describeRun(
        this.agent.start(body?.goal, {
          minutes:
            typeof body?.maxMinutes === "number" ? body.maxMinutes : undefined,
        }),
      ),
    );
  }

  @Post("runs/:id/cancel")
  @HttpCode(200)
  cancel(@Param("id") id: string) {
    return this.guard(() => describeRun(this.agent.cancel(this.id(id))));
  }

  @Post("runs/:id/respond")
  @HttpCode(200)
  async respond(
    @Param("id") id: string,
    @Body() body: { answer?: unknown; approve?: unknown },
  ) {
    try {
      return describeRun(
        await this.agent.respond(this.id(id), {
          answer: typeof body?.answer === "string" ? body.answer : undefined,
          approve:
            typeof body?.approve === "boolean" ? body.approve : undefined,
        }),
      );
    } catch (error) {
      if (error instanceof AgentError)
        throw new ValidationError([error.message]);
      throw error;
    }
  }

  private id(id: string): string {
    if (!ID.test(id)) throw new ValidationError(["Ongeldige taak."]);
    return id;
  }
  private guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AgentError)
        throw new ValidationError([error.message]);
      throw error;
    }
  }
}
