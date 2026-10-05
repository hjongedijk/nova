import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import { ChecksService } from "../../src/checks/checks.service.js";
import { ChecksSource } from "../../src/checks/checks.source.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import type { ProxmoxService } from "../../src/proxmox/proxmox.service.js";

let server: http.Server;
let port = 0;
let dir: string;
let events: InfrastructureEvent[];
let targets = "";
let guests: () => unknown[] = () => [];
let nodes: () => unknown[] = () => [{ node: "pve", status: "online" }];
let storage: () => unknown[] = () => [];
let proxmoxDown = false;
let proxmoxConfigured = false;
let store: JarvisStateStore;
let checks: ChecksService;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.statusCode = req.url === "/broken" ? 503 : 200;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

function boot() {
  const config = {
    get checkTargets() {
      return targets;
    },
    proxmox: { url: "" },
    dataFile: (n: string) => path.join(dir, n),
  } as unknown as NovaConfig;
  const proxmox = {
    get configured() {
      return proxmoxConfigured;
    },
    resources: async (type: string) => {
      if (proxmoxDown) throw new Error("down");
      return type === "vm" ? guests() : storage();
    },
    rawNodes: async () => {
      if (proxmoxDown) throw new Error("down");
      return nodes();
    },
  } as unknown as ProxmoxService;
  store = new JarvisStateStore(config, {
    publish: () => undefined,
  } as unknown as MqttService);
  events = [];
  store.onEvent((e) => events.push(e));
  checks = new ChecksService(config, store, proxmox);
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-checks-"));
  targets = `webup=http://127.0.0.1:${port}/`;
  guests = () => [];
  nodes = () => [{ node: "pve", status: "online" }];
  storage = () => [];
  proxmoxDown = false;
  proxmoxConfigured = false;
  boot();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const alertTitles = () =>
  events
    .splice(0)
    .filter((e) => e.topic === "jarvis/alerts")
    .map((e) => `${e.payload.severity}:${e.payload.title}`);

describe("network_check", () => {
  it("reports each target, flags broken ones, and refuses unknown names", async () => {
    targets = `webup=http://127.0.0.1:${port}/,webbroken=http://127.0.0.1:${port}/broken,closed=tcp://127.0.0.1:1`;
    const source = new ChecksSource(checks);
    const all = (await source.execute("network_check", {})).result as {
      allUp: boolean;
      results: { name: string; ok: boolean }[];
    };
    expect(all.allUp).toBe(false);
    const by = Object.fromEntries(all.results.map((r) => [r.name, r]));
    expect([by.webup?.ok, by.webbroken?.ok, by.closed?.ok]).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      (
        (await source.execute("network_check", { target: "webup" })).result as {
          allUp: boolean;
        }
      ).allUp,
    ).toBe(true);
    expect(
      (await source.execute("network_check", { target: "10.0.0.5" })).error,
    ).toMatch(/Onbekend doel/);
  });

  it("offers alerts_list and network_check as read-only tools", () => {
    expect(
      new ChecksSource(checks).definitions().map((d) => [d.name, d.risk]),
    ).toEqual([
      ["alerts_list", "READ_ONLY"],
      ["network_check", "READ_ONLY"],
    ]);
  });
});

describe("watchdog", () => {
  it("first run only observes, then reports transitions once and recovery", async () => {
    proxmoxConfigured = true;
    let status = "running";
    guests = () => [{ vmid: 104, name: "web", status }];
    await checks.watchdog();
    expect(alertTitles()).toEqual([]);
    status = "stopped";
    await checks.watchdog();
    expect(alertTitles()).toEqual(["warning:web is gestopt"]);
    await checks.watchdog();
    expect(alertTitles()).toEqual([]);
    status = "running";
    await checks.watchdog();
    expect(alertTitles()).toEqual(["info:web draait weer"]);
    const listed = checks.alerts();
    expect(listed).toHaveLength(2);
    expect(listed.find((a) => a.severity === "warning")?.open).toBe(false);
    const viaTool = await new ChecksSource(checks).execute("alerts_list", {
      limit: 1,
    });
    expect((viaTool.result as { alerts: unknown[] }).alerts).toHaveLength(1);
  });

  it("full storage, offline node and unreachable Proxmox each raise one alert", async () => {
    proxmoxConfigured = true;
    nodes = () => [{ node: "pve2", status: "offline" }];
    storage = () => [
      { storage: "san", disk: 95, maxdisk: 100 },
      { storage: "ok", disk: 10, maxdisk: 100 },
    ];
    await checks.watchdog();
    await checks.watchdog();
    expect(alertTitles().sort()).toEqual([
      "critical:Node pve2 is offline",
      "warning:Opslag san zit bijna vol",
    ]);
    proxmoxDown = true;
    await checks.watchdog();
    await checks.watchdog();
    expect(alertTitles()).toEqual(["warning:Proxmox is niet bereikbaar"]);
  });

  it("a service must miss twice before it is reported, and recovery is announced", async () => {
    let up = false;
    const flaky = http.createServer((_req, res) => {
      res.statusCode = up ? 200 : 503;
      res.end("x");
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    targets = `flaky=http://127.0.0.1:${(flaky.address() as AddressInfo).port}/`;
    await checks.watchdog();
    expect(alertTitles()).toEqual([]);
    await checks.watchdog();
    expect(alertTitles()).toEqual(["warning:flaky reageert niet"]);
    await checks.watchdog();
    expect(alertTitles()).toEqual([]);
    up = true;
    await checks.watchdog();
    expect(alertTitles()).toEqual(["info:flaky is weer bereikbaar"]);
    flaky.close();
  });
});
