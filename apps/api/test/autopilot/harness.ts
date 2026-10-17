import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { AutopilotService } from "../../src/autopilot/autopilot.service.js";
import { AutopilotStore } from "../../src/autopilot/autopilot.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** 2026-10-17 12:00 in Amsterdam (CEST, UTC+2). */
export const NOON = Date.UTC(2026, 9, 17, 10, 0);
/** 00:30 local: quiet hours. */
export const NIGHT = Date.UTC(2026, 9, 17, 22, 30);

export interface World {
  tools: Record<string, { risk: string; enabled?: boolean }>;
  events: Array<Record<string, unknown>>;
  calendarConfigured: boolean;
  entities: Array<Record<string, unknown>>;
  haOk: boolean;
  routing: { ready: boolean; status: string; reason?: string };
  mcp: Array<{ id: string; enabled: boolean; connected: boolean }>;
  mcpRefreshHeals: boolean;
  ha: { configured: boolean; stale: boolean };
  haSyncHeals: boolean;
  runs: Array<Record<string, unknown>>;
  objectives: Array<Record<string, unknown>>;
  listItems: number;
  timers: number;
  disk: number | null;
  proxmoxOk: boolean;
  services: Array<{ name: string; ok: boolean }>;
  telephony: {
    enabled: boolean;
    ready: { ready: boolean; reason?: string };
    contacts: string[];
    failText: boolean;
  };
  level: "careful" | "balanced" | "independent";
  alerts: Array<{ payload: Record<string, unknown> }>;
  texts: Array<{ to: string; body: string }>;
  toolCalls: Array<{ name: string; readOnlyOnly?: boolean; session: string }>;
  createdObjectives: Array<Record<string, unknown>>;
}

export function newWorld(): World {
  return {
    tools: {
      calendar_events: { risk: "READ_ONLY" },
      ha_search_entities: { risk: "READ_ONLY" },
      list_show: { risk: "READ_ONLY" },
      timer_list: { risk: "READ_ONLY" },
      network_check: { risk: "READ_ONLY" },
      proxmox_status: { risk: "READ_ONLY" },
      proxmox_guests: { risk: "READ_ONLY" },
      phone_call: { risk: "CONFIRM" },
    },
    events: [],
    calendarConfigured: true,
    entities: [],
    haOk: true,
    routing: { ready: true, status: "OK" },
    mcp: [],
    mcpRefreshHeals: false,
    ha: { configured: false, stale: false },
    haSyncHeals: false,
    runs: [],
    objectives: [],
    listItems: 0,
    timers: 0,
    disk: 60,
    proxmoxOk: false,
    services: [
      { name: "omniroute", ok: true },
      { name: "mqtt", ok: true },
      { name: "qdrant", ok: true },
      { name: "webhook", ok: true },
    ],
    telephony: {
      enabled: false,
      ready: { ready: true },
      contacts: [],
      failText: false,
    },
    level: "balanced",
    alerts: [],
    texts: [],
    toolCalls: [],
    createdObjectives: [],
  };
}

export const event = (summary: string, startMs: number) => ({
  summary,
  start: new Date(startMs).toISOString(),
  end: null,
  timeZone: null,
  allDay: false,
});

export const entity = (id: string, state: string, name = id) => ({
  entity_id: id,
  state,
  friendly_name: name,
});

export interface Rig {
  dir: string;
  world: World;
  clock: { t: number };
  store: AutopilotStore;
  service: AutopilotService;
  phoneCalls: Array<Record<string, unknown>>;
  /** A new service on the same data folder: a restart. */
  restart(): AutopilotService;
}

export function rig(
  start = NOON,
  existing?: { dir: string; world: World },
): Rig {
  const dir =
    existing?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-"));
  const world = existing?.world ?? newWorld();
  const clock = { t: start };
  const config = {
    dataFile: (name: string) => path.join(dir, name),
    timezone: "Europe/Amsterdam",
  } as unknown as NovaConfig;
  const store = new AutopilotStore(config);
  const phoneCalls: Array<Record<string, unknown>> = [];

  const tools = {
    list: () =>
      Object.entries(world.tools).map(([name, t]) => ({
        name,
        risk: t.risk,
        enabled: t.enabled !== false,
      })),
    execute: async (
      name: string,
      args: Record<string, unknown>,
      session: string,
      _approved: unknown,
      _always: unknown,
      options: { readOnlyOnly?: boolean } = {},
    ) => {
      world.toolCalls.push({
        name,
        readOnlyOnly: options.readOnlyOnly,
        session,
      });
      switch (name) {
        case "calendar_events":
          return {
            ok: true,
            result: {
              configured: world.calendarConfigured,
              events: world.events,
            },
          };
        case "ha_search_entities":
          return world.haOk
            ? { ok: true, result: world.entities }
            : { ok: false, error: "down" };
        case "list_show":
          return {
            ok: true,
            result: {
              list: "taken",
              items: Array.from({ length: world.listItems }, (_, i) => ({
                id: String(i),
                text: `item ${i}`,
              })),
            },
          };
        case "timer_list":
          return { ok: true, result: { count: world.timers, timers: [] } };
        case "proxmox_status":
          return world.proxmoxOk
            ? { ok: true, result: { nodes: [] } }
            : { ok: false, error: "not configured" };
        case "network_check":
          return { ok: true, result: { results: world.services } };
        case "phone_call":
          phoneCalls.push(args);
          return { ok: true };
        default:
          return { ok: false, error: "unknown" };
      }
    },
  };

  const objectives = {
    list: () => world.objectives,
    create: vi.fn((input: Record<string, unknown>) => {
      world.createdObjectives.push(input);
      return { objective: { id: "abcd1234" }, duplicate: false };
    }),
  };
  const agent = {
    list: () => world.runs,
    start: vi.fn(() => ({ id: "run" })),
  };
  const telephony = {
    get enabled() {
      return world.telephony.enabled;
    },
    textReady: async () => world.telephony.ready,
    conversationContacts: () => world.telephony.contacts,
    sendText: async (to: string, body: string) => {
      if (world.telephony.failText) throw new Error("nope");
      world.texts.push({ to, body });
    },
  };
  const mcp = {
    status: () => ({ servers: world.mcp }),
    refresh: async (id: string) => {
      if (world.mcpRefreshHeals)
        for (const s of world.mcp) if (s.id === id) s.connected = true;
    },
  };
  const home = {
    get configured() {
      return world.ha.configured;
    },
    health: () => ({ stale: world.ha.stale, online: !world.ha.stale }),
    sync: async () => {
      if (world.haSyncHeals) world.ha.stale = false;
    },
  };
  const routing = { status: () => world.routing };

  const make = () => {
    const service = new AutopilotService(
      store,
      tools as never,
      {
        emit: (e: { payload: Record<string, unknown> }) => world.alerts.push(e),
      } as never,
      objectives as never,
      agent as never,
      { get: () => world.level } as never,
      { record: vi.fn() } as never,
      config,
      telephony as never,
      routing as never,
      undefined,
      mcp as never,
      home as never,
      { setGoalDelegator: vi.fn() } as never,
    );
    service.now = () => clock.t;
    // Disk is read from the real file system otherwise.
    (
      service as unknown as { diskFree: () => Promise<number | null> }
    ).diskFree = async () => world.disk;
    (service as unknown as { memoryFree: () => number | null }).memoryFree =
      () => 50;
    service.recover();
    return service;
  };

  const r: Rig = {
    dir,
    world,
    clock,
    store,
    service: make(),
    phoneCalls,
    restart() {
      r.service = make();
      return r.service;
    },
  };
  return r;
}

export const titles = (w: World) =>
  w.alerts.map((a) => String(a.payload.title));
