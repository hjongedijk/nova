import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { HostHistory, HostSample, NetworkRate } from "@nova/contracts";
import fs from "node:fs";
import os from "node:os";
import { NovaConfig } from "../core/config/nova-config.js";

const HISTORY_LENGTH = 90;
const SAMPLE_EVERY_MS = 3000;

const cpuTimes = () => {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
};

/**
 * How busy this machine is, sampled on the server every few seconds so a freshly opened page already
 * has graphs. Network throughput comes from the node-exporter on the host (inside a container
 * /proc/net/dev only shows the container's own interface); without it the graph is not offered.
 */
@Injectable()
export class HostMetricsService implements OnModuleInit, OnModuleDestroy {
  private previousCpu = cpuTimes();
  private last: HostSample | null = null;
  private lastAt = 0;
  private networkPrevious: { at: number; rx: number; tx: number } | null = null;
  private currentNetwork: NetworkRate | null = null;
  private readonly series: HostHistory = {
    cpu: [],
    memory: [],
    rx: [],
    tx: [],
  };
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly config: NovaConfig) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.record();
    void this.sampleNetwork();
    this.timers = [
      setInterval(() => this.record(), SAMPLE_EVERY_MS),
      setInterval(() => void this.sampleNetwork(), SAMPLE_EVERY_MS),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  private memoryAvailable(): number {
    try {
      const match = /^MemAvailable:\s+(\d+) kB/m.exec(
        fs.readFileSync("/proc/meminfo", "utf8"),
      );
      if (match) return Number(match[1]) * 1024;
    } catch {
      /* Not Linux: the OS figure will do. */
    }
    return os.freemem();
  }

  private diskUsage(): { total: number; used: number } | null {
    try {
      const stats = fs.statfsSync(this.config.dataDir);
      const total = stats.blocks * stats.bsize;
      return { total, used: total - stats.bfree * stats.bsize };
    } catch {
      return null;
    }
  }

  /** The current numbers. Viewers within a second of each other share one sample: a CPU delta over milliseconds is noise. */
  sample(now = Date.now()): HostSample {
    if (this.last && now - this.lastAt < 1000) return this.last;
    const current = cpuTimes();
    const total = current.total - this.previousCpu.total;
    const idle = current.idle - this.previousCpu.idle;
    const cpu =
      total > 0
        ? (1 - idle / total) * 100
        : current.total > 0
          ? (1 - current.idle / current.total) * 100
          : 0;
    this.previousCpu = current;
    const memoryTotal = os.totalmem();
    this.lastAt = now;
    this.last = {
      at: new Date(now).toISOString(),
      cpu: Math.round(Math.min(100, Math.max(0, cpu)) * 10) / 10,
      cores: os.cpus().length,
      load: os.loadavg().map((value) => Math.round(value * 100) / 100),
      memory: {
        total: memoryTotal,
        used: memoryTotal - this.memoryAvailable(),
      },
      disk: this.diskUsage(),
      uptime: Math.round(os.uptime()),
    };
    return this.last;
  }

  get network(): NetworkRate | null {
    return this.currentNetwork;
  }

  history(): HostHistory {
    return Object.fromEntries(
      Object.entries(this.series).map(([key, values]) => [key, [...values]]),
    ) as unknown as HostHistory;
  }

  record(): void {
    const sample = this.sample();
    this.series.cpu.push(sample.cpu);
    this.series.memory.push(
      Math.round((sample.memory.used / sample.memory.total) * 1000) / 10,
    );
    this.series.rx.push(this.currentNetwork?.rxPerSec ?? 0);
    this.series.tx.push(this.currentNetwork?.txPerSec ?? 0);
    for (const values of Object.values(this.series))
      if (values.length > HISTORY_LENGTH) values.shift();
  }

  /** Bytes/s over the last interval, summed over the real interfaces. */
  async sampleNetwork(
    now = Date.now(),
    fetcher: typeof fetch = fetch,
  ): Promise<void> {
    const exporter =
      process.env.NODE_EXPORTER_URL || "http://host.docker.internal:9100";
    try {
      const response = await fetcher(`${exporter}/metrics`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error("exporter");
      const text = await response.text();
      let rx = 0;
      let tx = 0;
      for (const match of text.matchAll(
        /^node_network_(receive|transmit)_bytes_total\{device="([^"]+)"\}\s+([0-9.e+]+)/gm,
      )) {
        if (/^(lo|veth|docker|br-|virbr|tap|fw)/.test(match[2]!)) continue;
        if (match[1] === "receive") rx += Number(match[3]);
        else tx += Number(match[3]);
      }
      if (this.networkPrevious && now > this.networkPrevious.at) {
        const seconds = (now - this.networkPrevious.at) / 1000;
        this.currentNetwork = {
          rxPerSec: Math.max(
            0,
            Math.round((rx - this.networkPrevious.rx) / seconds),
          ),
          txPerSec: Math.max(
            0,
            Math.round((tx - this.networkPrevious.tx) / seconds),
          ),
        };
      }
      this.networkPrevious = { at: now, rx, tx };
    } catch {
      this.currentNetwork = null;
      this.networkPrevious = null;
    }
  }
}
