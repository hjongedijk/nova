import {
  ObjectiveError,
  type Condition,
  type ObjectiveCheck,
  type ObjectiveKind,
  type Operator,
  type Urgency,
} from "./objectives.types.js";

/** The model never supplies tools: it picks a template and fills in these parameters. */
export interface TemplateParams {
  target?: unknown;
  entity?: unknown;
  operator?: unknown;
  value?: unknown;
  cpuMax?: unknown;
  memMax?: unknown;
  maxStopped?: unknown;
  consecutive?: unknown;
}

export interface Template {
  description: string;
  defaultKind: ObjectiveKind;
  defaultInterval: number;
  build(params: TemplateParams): {
    checks: ObjectiveCheck[];
    params: Record<string, unknown>;
  };
}

/** Only these tools may ever be named by a check, on top of the READ_ONLY risk the registry reports. */
export const CHECK_TOOLS: ReadonlySet<string> = new Set([
  "proxmox_status",
  "proxmox_guests",
  "network_check",
  "ha_get_state",
  "calendar_events",
]);

const OPERATORS = new Set<string>([">", "<", ">=", "<=", "==", "!="]);
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const TARGET = /^[a-z0-9._-]{1,40}$/i;

function check(
  id: string,
  label: string,
  tool: string,
  args: Record<string, unknown>,
  condition: Condition,
  needed: number,
  urgency: Urgency,
): ObjectiveCheck {
  return {
    id,
    label,
    tool,
    args,
    condition,
    needed,
    urgency,
    state: { consecutive: 0, errors: 0, active: false },
  };
}

function integerParam(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new ObjectiveError(`${name} moet tussen ${min} en ${max} liggen.`);
  return Math.round(n);
}

export const TEMPLATES: Record<string, Template> = {
  servers_gezond: {
    description:
      "Proxmox nodes online with CPU and memory under a limit, no stopped guests, and all NOVA services reachable.",
    defaultKind: "monitor",
    defaultInterval: 10,
    build(p) {
      const cpuMax = integerParam(p.cpuMax, "cpuMax", 50, 100, 90);
      const memMax = integerParam(p.memMax, "memMax", 50, 100, 90);
      const maxStopped = integerParam(p.maxStopped, "maxStopped", 0, 200, 0);
      return {
        params: { cpuMax, memMax, maxStopped },
        checks: [
          check(
            "node-offline",
            "Proxmox-node offline",
            "proxmox_status",
            {},
            {
              kind: "compare",
              path: "nodes[].status",
              op: "!=",
              value: "online",
            },
            2,
            "urgent",
          ),
          check(
            "cpu",
            `CPU boven ${cpuMax}%`,
            "proxmox_status",
            {},
            {
              kind: "compare",
              path: "nodes[].cpu.usagePercent",
              op: ">",
              value: cpuMax,
            },
            3,
            "warn",
          ),
          check(
            "geheugen",
            `Geheugen boven ${memMax}%`,
            "proxmox_status",
            {},
            {
              kind: "compare",
              path: "nodes[].memory.usagePercent",
              op: ">",
              value: memMax,
            },
            3,
            "warn",
          ),
          check(
            "gasten",
            "Gestopte VM's of containers",
            "proxmox_guests",
            {},
            {
              kind: "compare",
              path: "summary.stopped",
              op: ">",
              value: maxStopped,
            },
            2,
            "info",
          ),
          check(
            "diensten",
            "Dienst reageert niet",
            "network_check",
            {},
            { kind: "compare", path: "results[].ok", op: "==", value: false },
            2,
            "warn",
          ),
        ],
      };
    },
  },
  service_online: {
    description:
      "One NOVA service or configured check target (network_check target name) keeps answering.",
    defaultKind: "monitor",
    defaultInterval: 5,
    build(p) {
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (!TARGET.test(target))
        throw new ObjectiveError("Geef de naam van de dienst (target).");
      const needed = integerParam(p.consecutive, "consecutive", 1, 10, 2);
      return {
        params: { target: target.toLowerCase(), consecutive: needed },
        checks: [
          check(
            "dienst",
            `${target} reageert niet`,
            "network_check",
            { target: target.toLowerCase() },
            { kind: "compare", path: "results[].ok", op: "==", value: false },
            needed,
            "warn",
          ),
        ],
      };
    },
  },
  ha_waarde: {
    description:
      "A Home Assistant entity state compared with a value (for example cover.garage == open for 3 checks).",
    defaultKind: "monitor",
    defaultInterval: 5,
    build(p) {
      const entity = typeof p.entity === "string" ? p.entity.trim() : "";
      if (!ENTITY.test(entity))
        throw new ObjectiveError(
          "Geef een Home Assistant-entiteit zoals cover.garage.",
        );
      const operator =
        typeof p.operator === "string" ? p.operator.trim() : "==";
      if (!OPERATORS.has(operator))
        throw new ObjectiveError("Gebruik een van: > < >= <= == !=.");
      const raw = p.value;
      if (raw === undefined || raw === null || String(raw).trim() === "")
        throw new ObjectiveError("Geef de waarde om mee te vergelijken.");
      const text = String(raw).trim().slice(0, 40);
      const numeric = text !== "" && Number.isFinite(Number(text));
      const value: number | string = numeric ? Number(text) : text;
      if (!numeric && operator !== "==" && operator !== "!=")
        throw new ObjectiveError("Tekstwaarden kunnen alleen met == of !=.");
      const needed = integerParam(p.consecutive, "consecutive", 1, 20, 1);
      return {
        params: { entity, operator, value, consecutive: needed },
        checks: [
          check(
            "waarde",
            `${entity} ${operator} ${value}`,
            "ha_get_state",
            { entity_id: entity },
            { kind: "compare", path: "state", op: operator as Operator, value },
            needed,
            "warn",
          ),
        ],
      };
    },
  },
  agenda_leeg: {
    description:
      "The calendar has no appointments in the coming seven days (calendar_events is empty).",
    defaultKind: "monitor",
    defaultInterval: 360,
    build() {
      return {
        params: {},
        checks: [
          check(
            "agenda",
            "Geen afspraken de komende zeven dagen",
            "calendar_events",
            {},
            { kind: "empty", path: "events" },
            1,
            "info",
          ),
        ],
      };
    },
  },
};
