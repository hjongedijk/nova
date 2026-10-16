import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { AgentService } from "./agent.service.js";
import { AgentError, type AgentRun } from "./agent.types.js";

export function describeRun(run: AgentRun) {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    turns: `${run.turns}/${run.maxTurns}`,
    result: run.result,
    waitingFor: run.waiting
      ? { kind: run.waiting.kind, text: run.waiting.text }
      : undefined,
    lastStep: run.log.filter((l) => l.kind === "turn").at(-1)?.text,
  };
}

/** Tools through which NOVA starts, follows and steers background goals. */
@ToolSourceProvider()
export class AgentSource implements ToolSource {
  readonly source = "agent";
  constructor(private readonly agent: AgentService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "agent_run",
        description:
          "Work on a goal by yourself in the background, for tasks that take several steps or time (research, checking several things, preparing something). It keeps using your tools turn after turn and tells the user when it is done or needs help. Use it when the user says things like 'zoek dit uit', 'regel dat', 'werk aan ... en laat me weten'. Not for simple questions you can answer in this turn. The goal must be a complete, self-contained instruction.",
        parameters: schema({ goal: text(600), maxMinutes: integer(1, 30) }, [
          "goal",
        ]),
        risk: "SAFE",
      },
      {
        name: "agent_runs",
        description:
          "List the background goals with status, progress and result.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "agent_reply",
        description:
          "Answer a background goal that waits for the user: approve=true/false for a waiting action, or an answer to its question.",
        parameters: schema(
          { id: text(12), approve: { type: "boolean" }, answer: text(400) },
          ["id"],
        ),
        risk: "SAFE",
        allowStandingApproval: false,
      },
      {
        name: "agent_cancel",
        description: "Stop a background goal by id.",
        parameters: schema({ id: text(12) }),
        risk: "SAFE",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { sessionId: string },
  ): Promise<ToolResult> {
    try {
      // A background goal never starts another one: no runaway chains.
      if (name === "agent_run" && call.sessionId.startsWith("agent_"))
        return {
          ok: false,
          error: "Een taak kan zelf geen nieuwe taak starten.",
        };
      if (name === "agent_run") {
        const run = this.agent.start(args.goal, {
          minutes:
            typeof args.maxMinutes === "number" ? args.maxMinutes : undefined,
        });
        return {
          ok: true,
          verified: true,
          result: describeRun(run),
          hint: "Zeg kort dat je eraan werkt en dat je laat weten als het klaar is.",
        };
      }
      if (name === "agent_runs")
        return {
          ok: true,
          result: this.agent.list().slice(0, 10).map(describeRun),
        };
      const id = String(args.id);
      if (name === "agent_cancel")
        return {
          ok: true,
          verified: true,
          result: describeRun(this.agent.cancel(id)),
        };
      if (name === "agent_reply")
        return {
          ok: true,
          verified: true,
          result: describeRun(
            await this.agent.respond(id, {
              answer: typeof args.answer === "string" ? args.answer : undefined,
              approve:
                typeof args.approve === "boolean" ? args.approve : undefined,
            }),
          ),
        };
      return { ok: false, error: "Onbekende taaktool." };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof AgentError
            ? error.message
            : "De taakactie is mislukt.",
      };
    }
  }
}
