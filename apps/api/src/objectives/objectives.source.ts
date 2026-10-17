import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { ObjectivesService } from "./objectives.service.js";
import { TEMPLATES } from "./objectives.templates.js";
import { ObjectiveError, type Objective } from "./objectives.types.js";

const WEEK = 7 * 86_400_000;

export function describeObjective(o: Objective, now = Date.now()) {
  return {
    id: o.id,
    title: o.title,
    kind: o.kind,
    template: o.template,
    enabled: o.enabled,
    intervalMinutes: o.intervalMinutes,
    quietHours: o.quiet.enabled ? `${o.quiet.start}-${o.quiet.end}` : "uit",
    expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : undefined,
    fulfilledAt: o.fulfilledAt
      ? new Date(o.fulfilledAt).toISOString()
      : undefined,
    lastResult: o.lastResult
      ? { ...o.lastResult, at: new Date(o.lastResult.at).toISOString() }
      : undefined,
    activeAnomaly: o.active
      ? {
          since: new Date(o.active.since).toISOString(),
          urgency: o.active.urgency,
          detail: o.active.detail,
          dismissed: o.active.dismissed,
        }
      : undefined,
    counters: o.counters,
    anomaliesLast7Days: o.anomalyLog.filter((t) => t > now - WEEK).length,
    lastInvestigation: o.lastInvestigation
      ? {
          at: new Date(o.lastInvestigation.at).toISOString(),
          summary: o.lastInvestigation.summary,
        }
      : undefined,
    history: o.history.map((h) => ({
      at: new Date(h.at).toISOString(),
      status: h.status,
      delivery: h.delivery,
    })),
  };
}

const templates = Object.keys(TEMPLATES);
const str = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});

/** Tools through which NOVA sets up, inspects and steers standing objectives. */
@ToolSourceProvider()
export class ObjectivesSource implements ToolSource {
  readonly source = "objectives";
  constructor(private readonly objectives: ObjectivesService) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "objective_create",
        description: `Start a standing objective that NOVA keeps watching without being asked again: 'houd de garage in de gaten', 'zorg dat mijn servers gezond blijven', 'laat het me weten als de dienst uitvalt', monitor something. You choose a template, never a tool. Templates: servers_gezond (Proxmox nodes, guests and services; optional cpuMax, memMax, maxStopped), service_online (target = network_check name), ha_waarde (entity like cover.garage, operator, value, consecutive = number of checks), agenda_leeg (no appointments in the next seven days). kind 'followup' tells the user once and then ends. Checks run in code every intervalMinutes (min 5) with read-only tools; quiet hours 23:00-07:00 and a daily notification budget apply. At most 5 active objectives.`,
        parameters: schema(
          {
            title: text(120),
            template: { type: "string", enum: templates },
            kind: { type: "string", enum: ["monitor", "followup"] },
            intervalMinutes: integer(5, 1440),
            expiresInDays: integer(1, 365),
            cooldownMinutes: integer(0, 1440),
            target: str(40),
            entity: str(80),
            operator: {
              type: "string",
              enum: [">", "<", ">=", "<=", "==", "!="],
            },
            value: { type: ["string", "number"], maxLength: 40 },
            cpuMax: integer(50, 100),
            memMax: integer(50, 100),
            maxStopped: integer(0, 200),
            consecutive: integer(1, 20),
          },
          ["title", "template"],
        ),
        risk: "CONFIRM",
      },
      {
        name: "objective_list",
        description:
          "List the standing objectives with status, last result, active anomaly, counters (checks, anomalies, false alarms), anomalies in the last 7 days and the last investigation. Use it to answer 'wat houd je in de gaten' or 'hoe ging het afgelopen week'.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "objective_update",
        description:
          "Change a standing objective by id: title, intervalMinutes, cooldownMinutes between notifications, quietHours ('uit', 'aan' or '22:00-08:00'), expiresInDays. dismiss=true tells NOVA the current alert was a false alarm: it stays quiet about it and the counter is kept.",
        parameters: schema(
          {
            id: text(12),
            title: text(120),
            intervalMinutes: integer(5, 1440),
            cooldownMinutes: integer(0, 1440),
            quietHours: str(20),
            expiresInDays: integer(1, 365),
            dismiss: { type: "boolean" },
          },
          ["id"],
        ),
        risk: "SAFE",
      },
      {
        name: "objective_pause",
        description: "Pause a standing objective by id; it keeps its history.",
        parameters: schema({ id: text(12) }),
        risk: "SAFE",
      },
      {
        name: "objective_resume",
        description: "Resume a paused or finished standing objective by id.",
        parameters: schema({ id: text(12) }),
        risk: "SAFE",
      },
      {
        name: "objective_delete",
        description:
          "Delete a standing objective and its history by id. Needs the user's confirmation.",
        parameters: schema({ id: text(12) }),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: Pick<ToolCall, "sessionId">,
  ): Promise<ToolResult> {
    try {
      if (name === "objective_list")
        return {
          ok: true,
          result: this.objectives
            .list()
            .map((o) => describeObjective(o, this.objectives.now())),
        };
      // An objective or a background goal never sets up, changes or removes objectives: no runaway chains.
      if (
        call.sessionId.startsWith("objective_") ||
        call.sessionId.startsWith("agent_")
      )
        return {
          ok: false,
          error: "Een achtergrondtaak kan geen doelen beheren.",
        };
      if (name === "objective_create") {
        const {
          title,
          template,
          kind,
          intervalMinutes,
          expiresInDays,
          cooldownMinutes,
          ...params
        } = args;
        const { objective, duplicate } = this.objectives.create({
          title,
          template,
          kind,
          intervalMinutes,
          expiresInDays,
          cooldownMinutes,
          params,
        });
        return {
          ok: true,
          verified: true,
          result: describeObjective(objective, this.objectives.now()),
          hint: duplicate
            ? "Dit doel liep al; zeg dat."
            : "Zeg kort wat je in de gaten houdt, hoe vaak, en dat je alleen meldt als er iets aan de hand is.",
        };
      }
      const id = String(args.id);
      const now = this.objectives.now();
      if (name === "objective_update")
        return {
          ok: true,
          verified: true,
          result: describeObjective(
            this.objectives.update(id, {
              title: args.title,
              intervalMinutes: args.intervalMinutes,
              cooldownMinutes: args.cooldownMinutes,
              quietHours: args.quietHours,
              expiresInDays: args.expiresInDays,
              dismiss: args.dismiss,
            }),
            now,
          ),
        };
      if (name === "objective_pause" || name === "objective_resume")
        return {
          ok: true,
          verified: true,
          result: describeObjective(
            this.objectives.update(id, {
              enabled: name === "objective_resume",
            }),
            now,
          ),
        };
      if (name === "objective_delete")
        return {
          ok: true,
          verified: true,
          result: {
            deleted: describeObjective(this.objectives.remove(id), now).title,
          },
        };
      return { ok: false, error: "Onbekende doeltool." };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ObjectiveError
            ? error.message
            : "De doelactie is mislukt.",
      };
    }
  }
}
