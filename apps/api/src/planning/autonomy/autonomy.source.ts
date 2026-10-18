import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../../tools/tool.types.js";
import { AutonomyService, type CreateTaskInput } from "./autonomy.service.js";
import { AutonomyError, type AutoTask } from "./autonomy.types.js";

export function describeTask(task: AutoTask) {
  const waiting = task.run
    ? task.steps
        .filter((s) => task.run!.steps[s.id]?.status === "waiting_approval")
        .map((s) => s.tool)
    : [];
  return {
    id: task.id,
    title: task.title,
    status: waiting.length ? "waiting_approval" : task.status,
    trigger:
      task.trigger.kind === "event"
        ? `event ${task.trigger.name}`
        : task.trigger.kind === "every"
          ? `elke ${Math.round(task.trigger.everyMs / 60000)} min`
          : "eenmalig",
    nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
    runs: `${task.runs}/${task.budget.maxRuns}`,
    steps: task.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      status: task.run?.steps[step.id]?.status ?? "wacht",
    })),
    waitingForApproval: waiting,
    last: task.lastRun
      ? {
          at: new Date(task.lastRun.at).toISOString(),
          outcome: task.lastRun.outcome,
          summary: task.lastRun.summary,
        }
      : null,
  };
}

/** Tools through which the user creates, lists, approves and cancels durable autonomous tasks. */
@ToolSourceProvider()
export class AutonomySource implements ToolSource {
  readonly source = "planning";
  constructor(private readonly autonomy: AutonomyService) {}

  definitions(): ToolDefinition[] {
    const step = {
      type: "object",
      additionalProperties: false,
      required: ["tool"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,24}$" },
        tool: text(64),
        args: { type: "object" },
        dependsOn: { type: "array", maxItems: 7, items: { type: "string" } },
        maxAttempts: integer(1, 5),
        untilContains: text(120),
        pollEverySeconds: integer(30, 86400),
      },
    };
    return [
      {
        name: "autonomy_create",
        description:
          'Create a durable autonomous task that NOVA runs by itself, also after restarts, without a new user message: once ("runAt" ISO with offset, or "delaySeconds"), repeating ("everySeconds" >= 60) or when a Node-RED event arrives ("event" name). "steps" are existing tool calls run in order (later steps may depend on earlier ones via dependsOn); read-only steps retry with backoff; risky steps pause until the user approves them. Use "untilContains" on a read-only step for follow-up/watch tasks (poll until the result contains that text, then notify). The user is asked to confirm creation. Never put secrets in args.',
        parameters: schema(
          {
            title: text(80),
            steps: { type: "array", minItems: 1, maxItems: 8, items: step },
            runAt: text(40),
            delaySeconds: integer(0, 31_536_000),
            everySeconds: integer(60, 31_536_000),
            event: text(64),
            cooldownSeconds: integer(30, 86400),
            maxRuns: integer(1, 1000),
            maxToolCalls: integer(1, 200),
            maxRunMinutes: integer(1, 1440),
            expiresInDays: integer(1, 365),
            autoSafe: { type: "boolean" },
            notifyOnDone: { type: "boolean" },
          },
          ["title", "steps"],
        ),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
      {
        name: "autonomy_list",
        description:
          "List the autonomous tasks with status, next run, budget and what waits for approval.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "autonomy_cancel",
        description:
          "Cancel an autonomous task by id. Running steps are not repeated.",
        parameters: schema({ id: text(20) }),
        risk: "SAFE",
      },
      {
        name: "autonomy_approve",
        description:
          "Approve the waiting risky step(s) of an autonomous task by id, after the user said so.",
        parameters: schema({ id: text(20) }),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      if (name === "autonomy_create") {
        const { task, duplicate } = this.autonomy.create(
          args as unknown as CreateTaskInput,
        );
        return {
          ok: true,
          verified: true,
          result: { duplicate, task: describeTask(task) },
          hint: duplicate ? "Dezelfde taak loopt al." : undefined,
        };
      }
      if (name === "autonomy_list")
        return { ok: true, result: this.autonomy.list().map(describeTask) };
      const id = String(args.id);
      if (name === "autonomy_cancel")
        return this.autonomy.cancel(id)
          ? { ok: true, verified: true }
          : { ok: false, error: "Taak niet gevonden of al afgerond." };
      if (name === "autonomy_approve") {
        const approved = this.autonomy.approve(id);
        return approved.length
          ? { ok: true, verified: true, result: { approvedSteps: approved } }
          : { ok: false, error: "Geen wachtende stap gevonden voor die taak." };
      }
      return { ok: false, error: "Onbekende taaktool." };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof AutonomyError
            ? error.message
            : "De taakactie is mislukt.",
      };
    }
  }
}
