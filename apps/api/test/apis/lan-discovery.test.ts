import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lanHosts,
  proposalText,
  scanLan,
  type DiscoveryTransport,
} from "../../src/apis/lan-discovery.js";
import { LanDiscoveryService } from "../../src/apis/lan-discovery.service.js";
import { LanDiscoverySource } from "../../src/apis/lan-discovery.source.js";
import { isLanAddress } from "../../src/core/security/net-guard.js";

function fakeTransport(
  options: {
    interfaces?: { address: string; prefix: number }[];
    open?: string[];
    pages?: Record<string, string>;
    hints?: string[];
  } = {},
) {
  const touched: string[] = [];
  const transport: DiscoveryTransport = {
    interfaces: () =>
      options.interfaces ?? [{ address: "192.168.1.10", prefix: 24 }],
    tcpOpen: async (host, port) => {
      touched.push(`${host}:${port}`);
      return (options.open ?? []).includes(`${host}:${port}`);
    },
    httpGet: async (host, port) => {
      const body = options.pages?.[`${host}:${port}`];
      return body === undefined ? null : { status: 200, body };
    },
    multicastHints: async () => options.hints ?? [],
  };
  return { transport, touched };
}

describe("isLanAddress", () => {
  it("accepts RFC 1918 only", () => {
    for (const ok of ["10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.1"])
      expect(isLanAddress(ok)).toBe(true);
    for (const no of [
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "172.32.0.1",
      "8.8.8.8",
      "::1",
      "fd00::1",
      "example.com",
    ])
      expect(isLanAddress(no)).toBe(false);
  });
});

describe("scanLan", () => {
  it("only scans the own private /24 and never a public interface", () => {
    expect(
      lanHosts(
        [
          { address: "8.8.8.8", prefix: 24 },
          { address: "192.168.1.10", prefix: 16 },
        ],
        1000,
      ),
    ).toHaveLength(253);
    expect(lanHosts([{ address: "8.8.8.8", prefix: 24 }], 1000)).toEqual([]);
  });

  it("recognises services and ignores look-alikes", async () => {
    const { transport } = fakeTransport({
      open: [
        "192.168.1.20:8123",
        "192.168.1.30:1883",
        "192.168.1.40:8123",
        "192.168.1.50:6333",
      ],
      pages: {
        "192.168.1.20:8123": "<title>Home Assistant</title>",
        "192.168.1.40:8123": "<title>Something else</title>",
        "192.168.1.50:6333": '{"title":"qdrant - vector search engine"}',
      },
    });
    const report = await scanLan(transport, 1000);
    expect(report.found.map((c) => c.id).sort()).toEqual([
      "home_assistant@192.168.1.20:8123",
      "mqtt@192.168.1.30:1883",
      "qdrant@192.168.1.50:6333",
    ]);
    const ha = report.found.find((c) => c.service === "home_assistant")!;
    expect(ha.auth).toBe("token");
    expect(proposalText(ha).title).toBe(
      "Ik vond Home Assistant op 192.168.1.20",
    );
    expect(proposalText(ha).detail).toContain("verzin ik niet");
    const qdrant = report.found.find((c) => c.service === "qdrant")!;
    expect(proposalText(qdrant).detail).toContain("zonder inloggegevens");
  });

  it("drops non-LAN multicast hints and stays inside its request budget", async () => {
    const { transport, touched } = fakeTransport({
      hints: ["8.8.8.8", "192.168.1.77"],
    });
    const report = await scanLan(transport, 1, {
      maxHosts: 254,
      concurrency: 4,
      connectTimeoutMs: 10,
      budgetMs: 30_000,
      maxRequests: 50,
    });
    expect(touched.every((t) => !t.startsWith("8.8.8.8"))).toBe(true);
    expect(touched.some((t) => t.startsWith("192.168.1.77:"))).toBe(true);
    expect(report.requests).toBeLessThanOrEqual(50 + 4);
    expect(report.truncated).toBe(true);
  });
});

describe("LanDiscoveryService and tool", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  function make(registryHosts: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-"));
    dirs.push(dir);
    const config = { dataFile: (n: string) => path.join(dir, n) } as never;
    const registry = {
      list: () => registryHosts.map((h) => ({ baseUrl: `http://${h}:1880` })),
    } as never;
    const clock = { t: 1_000_000 };
    const build = () => {
      const service = new LanDiscoveryService(config, registry);
      service.now = () => clock.t;
      service.transport = fakeTransport({
        open: ["192.168.1.20:8123", "192.168.1.60:1880"],
        pages: {
          "192.168.1.20:8123": "Home Assistant",
          "192.168.1.60:1880": "<title>Node-RED</title>",
        },
      }).transport;
      return service;
    };
    return { build, clock };
  }

  it("rate limits manual rescans and persists candidates", async () => {
    const { build, clock } = make();
    const service = build();
    const first = await service.scan();
    expect(first.scanned).toBe(true);
    expect(first.candidates).toHaveLength(2);
    clock.t += 60_000;
    expect((await service.scan()).scanned).toBe(false);
    clock.t += 11 * 60_000;
    expect((await service.scan()).scanned).toBe(true);
    // Restart: same data, no scan needed within the autopilot interval.
    const again = build();
    expect(again.candidates()).toHaveLength(2);
    expect((await again.scan(24 * 3_600_000)).scanned).toBe(false);
  });

  it("does not propose what is dismissed or already connected", async () => {
    const { build } = make(["192.168.1.60"]);
    const service = build();
    await service.scan();
    expect(service.proposals().map((c) => c.service)).toEqual([
      "home_assistant",
    ]);
    service.dismiss("home_assistant@192.168.1.20:8123");
    expect(service.proposals()).toEqual([]);
  });

  it("lan_discover is a read-only tool that never connects anything", async () => {
    const { build } = make();
    const source = new LanDiscoverySource(build());
    expect(source.definitions()[0]).toMatchObject({
      name: "lan_discover",
      risk: "READ_ONLY",
    });
    const result = await source.execute("lan_discover", {}, {
      signal: new AbortController().signal,
    } as never);
    expect(result.ok).toBe(true);
    const found = (
      result.result as { found: { name: string; login: string }[] }
    ).found;
    expect(found.map((f) => f.name).sort()).toEqual([
      "Home Assistant",
      "Node-RED",
    ]);
    expect(result.hint).toContain("Never invent credentials");
  });
});
