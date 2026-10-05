import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import { StateService } from "../../src/core/state/state.service.js";
import { ProxmoxService } from "../../src/proxmox/proxmox.service.js";
import { ProxmoxSource } from "../../src/proxmox/proxmox.source.js";
import { SystemTimeSource } from "../../src/proxmox/system-time.source.js";
import { spokenTime } from "../../src/proxmox/system-time.js";

let actions: { url?: string; method?: string }[] = [];
let guestStatus = "stopped";
let server: http.Server;
let state: StateService;
let source: ProxmoxSource;
let service: ProxmoxService;
const call = { signal: new AbortController().signal };
const run = (name: string, args: Record<string, unknown> = {}) =>
  source.execute(name, args, call);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (
      req.headers.authorization !== "PVEAPIToken=test@pve!jarvis=mock-token"
    ) {
      res.statusCode = 401;
      return res.end("{}");
    }
    const url = req.url ?? "";
    let data: unknown;
    if (url === "/api2/json/nodes")
      data = [
        { node: "pve", status: "online", cpu: 0.25, mem: 512, maxmem: 1024 },
      ];
    else if (url.startsWith("/api2/json/cluster/resources?type=vm"))
      data = [
        {
          vmid: 104,
          node: "pve",
          type: "qemu",
          name: "demo",
          status: "running",
          cpu: 0.1,
          mem: 50,
          maxmem: 100,
          uptime: 20,
        },
        { vmid: 105, node: "pve", type: "lxc", name: "ct", status: "stopped" },
      ];
    else if (url.endsWith("/status/current"))
      data = { status: guestStatus, cpu: 0.2, mem: 60, maxmem: 100 };
    else if (url.startsWith("/api2/json/cluster/resources?type=storage"))
      data = [
        {
          storage: "local",
          status: "available",
          disk: 5,
          maxdisk: 10,
          plugintype: "dir",
        },
        { storage: "empty", disk: 0, maxdisk: 0 },
      ];
    else if (url.startsWith("/api2/json/cluster/tasks"))
      data = [{ type: "qmstart", status: "OK" }];
    else {
      actions.push({ url, method: req.method });
      data = "UPID:mock-task";
    }
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    timezone: "Europe/Amsterdam",
    proxmox: {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      tokenId: "test@pve!jarvis",
      tokenSecret: "mock-token",
      verifyTls: false,
    },
  } as NovaConfig;
  state = new StateService();
  const mqtt = { publish: () => undefined } as unknown as MqttService;
  service = new ProxmoxService(config, state, mqtt);
  source = new ProxmoxSource(service);
  source.verifyDelayMs = 1;
});
afterAll(() => server.close());
beforeEach(() => {
  actions = [];
  guestStatus = "stopped";
});

describe("ProxmoxSource", () => {
  it("offers the tools with the right risks", () => {
    const defs = source.definitions();
    const risk = Object.fromEntries(defs.map((d) => [d.name, d.risk]));
    expect(Object.keys(risk)).toEqual([
      "proxmox_status",
      "proxmox_nodes",
      "proxmox_guests",
      "proxmox_storage",
      "proxmox_tasks",
      "proxmox_guest_status",
      "proxmox_start_guest",
      "proxmox_stop_guest",
      "proxmox_shutdown_guest",
      "proxmox_reboot_guest",
    ]);
    expect(risk.proxmox_guests).toBe("READ_ONLY");
    expect(risk.proxmox_reboot_guest).toBe("CONFIRM");
    expect(defs.every((d) => d.enabled)).toBe(true);
  });

  it("answers all read-only tools and shows VM and LXC output", async () => {
    for (const name of ["status", "nodes", "guests", "storage", "tasks"])
      expect((await run(`proxmox_${name}`)).ok).toBe(true);
    const out = (await run("proxmox_guests")).result as {
      summary: Record<string, unknown>;
      guests: Record<string, unknown>[];
    };
    expect([
      out.summary.total,
      out.summary.running,
      out.summary.stopped,
      out.summary.stoppedNames,
    ]).toEqual([2, 1, 1, ["ct"]]);
    expect(out.guests[0]?.label).toBe("QEMU VM");
    expect(out.guests[1]?.label).toBe("LXC container");
    expect(out.guests[0]?.cpuUsagePercent).toBe(10);
    guestStatus = "running";
    const one = await run("proxmox_guest_status", { vmid: 104 });
    expect((one.result as { memoryUsed: number }).memoryUsed).toBe(60);
    expect((await run("proxmox_guest_status", { vmid: 999 })).error).toBe(
      "Guest not found",
    );
  });

  it("uses the fixed action path for both guest types and verifies the result", async () => {
    guestStatus = "running";
    const started = await run("proxmox_start_guest", { vmid: 104 });
    expect(actions.at(-1)).toEqual({
      url: "/api2/json/nodes/pve/qemu/104/status/start",
      method: "POST",
    });
    expect(started).toMatchObject({
      ok: true,
      accepted: true,
      verified: true,
      status: "verified",
    });
    guestStatus = "stopped";
    const stopped = await run("proxmox_shutdown_guest", { vmid: 105 });
    expect(actions.at(-1)?.url).toBe(
      "/api2/json/nodes/pve/lxc/105/status/shutdown",
    );
    expect(stopped.verified).toBe(true);
  });

  it("reports accepted_unverified when the state is not reached, and for reboot", async () => {
    guestStatus = "running";
    const stop = await run("proxmox_stop_guest", { vmid: 104 });
    expect(stop).toMatchObject({
      ok: true,
      verified: null,
      status: "accepted_unverified",
    });
    expect(stop.note).toMatch(/not yet been observed/);
    const reboot = await run("proxmox_reboot_guest", { vmid: 104 });
    expect(reboot.verified).toBeNull();
    expect(reboot.note).toMatch(/Reboot completion/);
  });

  it("keeps the component state and exposes typed dashboard data", async () => {
    await service.status();
    await service.guests();
    expect(state.get("proxmox")).toMatchObject({
      online: true,
      nodes: 1,
      guestsRunning: 1,
    });
    const guests = await service.guests();
    expect(guests.map((g) => g.vmid)).toEqual([104, 105]);
    expect(guests[0]).toMatchObject({ cpu: 10, memoryTotal: 100 });
    expect(await service.storage()).toEqual([
      { name: "local", type: "dir", used: 5, total: 10 },
    ]);
  });

  it("fails politely with wrong credentials and marks Proxmox offline", async () => {
    const bad = new ProxmoxService(
      {
        proxmox: {
          url: service["config"].proxmox.url,
          tokenId: "x",
          tokenSecret: "y",
          verifyTls: true,
        },
      } as NovaConfig,
      state,
      { publish: () => undefined } as unknown as MqttService,
    );
    const out = await new ProxmoxSource(bad).execute(
      "proxmox_guests",
      {},
      call,
    );
    expect(out).toEqual({
      ok: false,
      error: "Proxmox unavailable, misconfigured, or request failed",
    });
    expect(state.get("proxmox")?.online).toBe(false);
  });

  it("is disabled without configuration", () => {
    const off = new ProxmoxService(
      {
        proxmox: { url: "", tokenId: "", tokenSecret: "", verifyTls: true },
      } as NovaConfig,
      state,
      {} as MqttService,
    );
    expect(
      new ProxmoxSource(off).definitions().every((d) => d.enabled === false),
    ).toBe(true);
  });
});

describe("system_time", () => {
  it("speaks Dutch time", () => {
    expect(spokenTime(17, 50)).toEqual({
      spoken: "tien voor zes",
      partOfDay: "middag",
    });
    expect(spokenTime(8, 30).spoken).toBe("half negen");
    expect(spokenTime(23, 58)).toEqual({
      spoken: "twaalf uur",
      partOfDay: "avond",
    });
    expect(spokenTime(3, 15).partOfDay).toBe("nacht");
  });

  it("returns local time in the configured zone", async () => {
    const out = await new SystemTimeSource({
      timezone: "Europe/Amsterdam",
    } as NovaConfig).execute();
    const result = out.result as {
      local: { time: string; spoken: string };
      serverTimezone: string;
    };
    expect(result.serverTimezone).toBe("Europe/Amsterdam");
    expect(result.local.time).toMatch(/^\d\d:\d\d$/);
    expect(result.local.spoken).toBeTruthy();
  });
});
