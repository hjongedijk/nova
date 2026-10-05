import {
  integer,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ProxmoxService } from "../proxmox/proxmox.service.js";
import { localTime } from "../proxmox/system-time.js";
import { JarvisStateStore } from "./jarvis-state.store.js";
import { describeTimer, PlanningService } from "./planning.service.js";

const str = (min: number, max: number) => ({
  type: "string",
  minLength: min,
  maxLength: max,
});

@ToolSourceProvider()
export class PlanningSource implements ToolSource {
  readonly source = "planning";

  constructor(
    private readonly planning: PlanningService,
    private readonly store: JarvisStateStore,
    private readonly proxmox: ProxmoxService,
    private readonly config: NovaConfig,
  ) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: "timer_set",
        description:
          'Set a timer or reminder. Give seconds from now (for example 600 for ten minutes) or an absolute time in ISO 8601 with offset in "at" (call system_time first to know the current time). Optional label says what it is for. When it fires, NOVA tells the user out loud.',
        parameters: schema(
          { seconds: integer(1, 604800), at: str(10, 40), label: str(1, 60) },
          [],
        ),
        risk: "SAFE",
      },
      {
        name: "timer_list",
        description: "List the active timers and reminders with the time left.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
      {
        name: "timer_cancel",
        description: "Cancel an active timer by its id or by its label.",
        parameters: schema({ id: str(1, 20), label: str(1, 60) }, []),
        risk: "SAFE",
      },
      {
        name: "list_add",
        description:
          "Add an item to a named list such as boodschappen (shopping) or taken (to-do). The list is created when it does not exist.",
        parameters: schema({ list: text(40), item: text(200) }),
        risk: "SAFE",
      },
      {
        name: "list_show",
        description: "Show one list, or all lists when no list name is given.",
        parameters: schema({ list: text(40) }, []),
        risk: "READ_ONLY",
      },
      {
        name: "list_remove",
        description:
          "Remove an item from a list. Match by item text (a part is fine) or by id.",
        parameters: schema({ list: text(40), item: text(200) }),
        risk: "SAFE",
      },
      {
        name: "list_clear",
        description: "Empty a whole list. Requires confirmation.",
        parameters: schema({ list: text(40) }),
        risk: "CONFIRM",
      },
      {
        name: "daily_briefing",
        description:
          "Gather what a morning or evening briefing needs: date and time, server status, open alerts, active timers and the lists. Combine it with weather_forecast and news_headlines and tell it as one short story.",
        parameters: schema(),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      return { ok: true, result: await this.run(name, args) };
    } catch (error) {
      return {
        ok: false,
        error: String((error as Error).message || error).slice(0, 300),
      };
    }
  }

  private async run(name: string, args: Record<string, unknown>) {
    const a = args as {
      seconds?: number;
      at?: string;
      label?: string;
      id?: string;
    };
    const list = String(args.list ?? "");
    const item = String(args.item ?? "");
    switch (name) {
      case "timer_set":
        return this.planning.setTimer(a);
      case "timer_list": {
        const timers = this.planning.timers();
        return { count: timers.length, timers };
      }
      case "timer_cancel":
        return this.planning.cancelTimer(a);
      case "list_add":
        return this.planning.addItem(list, item);
      case "list_show":
        return this.planning.showList(list || undefined);
      case "list_remove":
        return this.planning.removeItem(list, item);
      case "list_clear":
        return this.planning.clearList(list);
      default:
        return this.briefing();
    }
  }

  private async briefing() {
    const state = this.store.data;
    const now = new Date();
    const tz = this.config.timezone;
    const local = localTime(now, tz);
    const result: Record<string, unknown> = {
      now: {
        iso: now.toISOString(),
        weekday: local.weekday,
        date: now.toLocaleDateString("nl-NL", {
          day: "numeric",
          month: "long",
          timeZone: tz,
        }),
        time: local.time,
        timezone: tz,
      },
      timers: state.timers.map((timer) => describeTimer(timer)),
      lists: Object.fromEntries(
        Object.entries(state.lists).map(([name, items]) => [
          name,
          { count: items.length, first: items.slice(0, 5).map((i) => i.text) },
        ]),
      ),
      openAlerts: state.alerts
        .filter((alert) => state.active[alert.key])
        .slice(0, 5),
      hint: "Voor een complete ochtendbriefing: vraag ook het weer (weather_forecast) en het nieuws (news_headlines) op en vertel het als één samenhangend verhaal.",
    };
    if (this.proxmox.configured) {
      try {
        const guests = await this.proxmox.resources("vm");
        const running = guests.filter((g) => g.status === "running");
        result.servers = {
          vmsRunning: running.length,
          vmsTotal: guests.length,
          stopped: guests
            .filter((g) => g.status !== "running")
            .map((g) => g.name)
            .slice(0, 8),
        };
      } catch {
        result.servers = { error: "Proxmox is niet bereikbaar" };
      }
    }
    return result;
  }
}
