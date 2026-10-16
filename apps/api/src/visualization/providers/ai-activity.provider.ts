import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { VizEdge, VizNode, VizStatus } from "@nova/contracts";
import {
  AuditService,
  type AuditEntry,
} from "../../core/audit/audit.service.js";
import { VisualizationRegistry } from "../visualization.registry.js";
import type {
  ProviderScene,
  VisualizationProvider,
  VizTypeDefinition,
} from "../visualization.types.js";

const SESSIONS = 6;
const SYSTEM = new Set(["health", "overview", "dashboard", "sidebar"]);

interface Call {
  tool: string;
  session: string;
  ok: boolean | null;
  pending: boolean;
  risk: string | null;
  ms: number | null;
  at: string;
}

/** Only real tool calls from the action log. Arguments and results are never read. */
export function callsFromAudit(entries: AuditEntry[]): Call[] {
  return entries.flatMap<Call>((entry) => {
    if (
      typeof entry.tool !== "string" ||
      entry.phase ||
      entry.confirmation === "standing_approval_created" ||
      typeof entry.sessionId !== "string"
    )
      return [];
    const result =
      entry.result && typeof entry.result === "object"
        ? (entry.result as Record<string, unknown>)
        : {};
    return [
      {
        tool: entry.tool,
        session: entry.sessionId,
        ok: typeof result.ok === "boolean" ? result.ok : null,
        pending: result.requiresConfirmation === true,
        risk: typeof entry.risk === "string" ? entry.risk : null,
        ms: typeof entry.durationMs === "number" ? entry.durationMs : null,
        at: entry.timestamp,
      },
    ];
  });
}

interface ToolStat {
  tool: string;
  calls: number;
  failed: number;
  pending: number;
  ms: number;
  timed: number;
  risk: string | null;
  last: Call;
  bySession: Map<string, number>;
}

function statFor(calls: Call[]): ToolStat[] {
  const stats = new Map<string, ToolStat>();
  // Calls come newest first, so the first one seen is the last call.
  for (const call of calls) {
    let stat = stats.get(call.tool);
    if (!stat) {
      stat = {
        tool: call.tool,
        calls: 0,
        failed: 0,
        pending: 0,
        ms: 0,
        timed: 0,
        risk: call.risk,
        last: call,
        bySession: new Map(),
      };
      stats.set(call.tool, stat);
    }
    stat.calls++;
    if (call.pending) stat.pending++;
    else if (call.ok === false) stat.failed++;
    if (call.ms !== null) {
      stat.ms += call.ms;
      stat.timed++;
    }
    stat.bySession.set(
      call.session,
      (stat.bySession.get(call.session) ?? 0) + 1,
    );
  }
  return [...stats.values()].sort(
    (a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool),
  );
}

const statusOf = (call: Call): VizStatus =>
  call.pending
    ? "warning"
    : call.ok === true
      ? "ok"
      : call.ok === false
        ? "critical"
        : "unknown";

const NOTE =
  "Alleen echte toolaanroepen uit het actielogboek (welke tool, wanneer, gelukt of niet). Dit toont geen redenering van het model; argumenten en resultaten worden niet gelezen.";

export function activityGraph(entries: AuditEntry[]): ProviderScene {
  const all = callsFromAudit(entries);
  const sessionOrder: string[] = [];
  for (const call of all)
    if (!sessionOrder.includes(call.session)) sessionOrder.push(call.session);
  const sessions = sessionOrder.slice(0, SESSIONS);
  const calls = all.filter((call) => sessions.includes(call.session));
  const nodes: VizNode[] = [
    {
      id: "nova",
      label: "NOVA",
      kind: "orchestrator",
      status: calls.length ? "ok" : "unknown",
      size: 1.6,
      layer: "sessions",
      detail: { aanroepen: calls.length, gesprekken: sessions.length },
    },
  ];
  const edges: VizEdge[] = [];
  let chat = 0;
  for (const [index, session] of sessions.entries()) {
    const own = calls.filter((call) => call.session === session);
    const system = SYSTEM.has(session);
    if (!system) chat++;
    nodes.push({
      id: `session:${index}`,
      label: system ? `Achtergrond: ${session}` : `Gesprek ${chat}`,
      kind: system ? "background" : "session",
      parent: "nova",
      layer: "sessions",
      status: "active",
      detail: {
        aanroepen: own.length,
        laatst: own[0]?.at ?? null,
      },
    });
    edges.push({ from: "nova", to: `session:${index}` });
  }
  const stats = statFor(calls);
  const top = stats[0]?.calls ?? 1;
  for (const stat of stats.slice(0, 80)) {
    const best = [...stat.bySession.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const parent = `session:${sessions.indexOf(best[0])}`;
    nodes.push({
      id: `tool:${stat.tool}`,
      label: stat.tool,
      kind: "tool",
      parent,
      layer: "tools",
      status: statusOf(stat.last),
      value: stat.calls / top,
      size: 0.7 + 0.8 * (stat.calls / top),
      detail: {
        aanroepen: stat.calls,
        mislukt: stat.failed,
        wacht_op_bevestiging: stat.pending,
        risico: stat.risk,
        gemiddelde_duur_ms: stat.timed
          ? Math.round(stat.ms / stat.timed)
          : null,
        laatste_aanroep: stat.last.at,
        laatste_uitkomst: stat.last.pending
          ? "wacht op bevestiging"
          : stat.last.ok === null
            ? "onbekend"
            : stat.last.ok
              ? "gelukt"
              : "mislukt",
      },
    });
    for (const [session, count] of stat.bySession) {
      const index = sessions.indexOf(session);
      if (index < 0) continue;
      edges.push({
        from: `session:${index}`,
        to: `tool:${stat.tool}`,
        label: `${count}×`,
        weight: Math.min(1, count / top),
        status:
          stat.last.ok === false && !stat.last.pending ? "critical" : undefined,
      });
    }
  }
  return {
    title: "AI-activiteit",
    nodes,
    edges,
    layers: [
      { id: "sessions", label: "NOVA en gesprekken" },
      { id: "tools", label: "Tools" },
    ],
    heatLabel: "Aantal aanroepen (t.o.v. de meest gebruikte tool)",
    notes: [
      NOTE,
      stats.length > 80
        ? `Alleen de 80 meest gebruikte van ${stats.length} tools zijn getekend.`
        : `Gebaseerd op de laatste ${calls.length} aanroepen in ${sessions.length} gesprekken of achtergrondtaken.`,
    ],
    refreshMs: 10_000,
  };
}

export function activityCalls(entries: AuditEntry[]): ProviderScene {
  const stats = statFor(callsFromAudit(entries)).slice(0, 20);
  return {
    title: "Toolaanroepen",
    chart: {
      type: "bar",
      unit: "aanroepen",
      series: [
        {
          label: "Aanroepen",
          points: stats.map((stat) => ({
            label: stat.tool,
            value: stat.calls,
            status: statusOf(stat.last),
          })),
        },
        {
          label: "Mislukt",
          points: stats.map((stat) => ({
            label: stat.tool,
            value: stat.failed,
            status: stat.failed ? ("critical" as const) : ("ok" as const),
          })),
        },
      ],
    },
    notes: [NOTE],
    refreshMs: 10_000,
  };
}

const TYPES: VizTypeDefinition[] = [
  {
    id: "graph",
    title: "AI-activiteit",
    kind: "graph",
    description:
      "Graaf van NOVA, recente gesprekken en de tools die echt zijn aangeroepen, met uitkomst en aantal. Geen modelredenering.",
    keywords: [
      "activiteit",
      "activity",
      "ai",
      "orkestratie",
      "orchestration",
      "toolgebruik",
      "tools",
      "aanroepen",
      "wat doet nova",
      "wat heb je gedaan",
    ],
  },
  {
    id: "calls",
    title: "Toolaanroepen",
    kind: "chart",
    description:
      "Staafgrafiek van de meest aangeroepen tools en hoeveel mislukten.",
    keywords: ["aanroepen", "meest gebruikt", "statistiek"],
  },
];

@Injectable()
export class AiActivityVisualizationProvider
  implements VisualizationProvider, OnModuleInit
{
  readonly id = "ai-activity";
  readonly label = "AI-activiteit";
  readonly types = TYPES;
  readonly requires = { service: "audit-log", access: "read-only" as const };

  constructor(
    private readonly audit: AuditService,
    private readonly registry: VisualizationRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  available(): { ok: true } {
    return { ok: true };
  }

  async build(typeId: string): Promise<ProviderScene> {
    const entries = this.audit.read(300);
    if (!entries.length)
      throw new Error("Er zijn nog geen toolaanroepen om te laten zien.");
    return typeId === "calls" ? activityCalls(entries) : activityGraph(entries);
  }
}
