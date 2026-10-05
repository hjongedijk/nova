import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { AlertInfo, ServiceCheckResult } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  JarvisStateStore,
  MAX_ALERTS,
  newId,
} from "../planning/jarvis-state.store.js";
import { ProxmoxService } from "../proxmox/proxmox.service.js";
import { parseTargets, probe } from "./probe.js";

interface Raise {
  key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail?: string;
}

/** Reachability checks and the watchdog that raises (and closes) alerts. */
@Injectable()
export class ChecksService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly config: NovaConfig,
    private readonly store: JarvisStateStore,
    private readonly proxmox: ProxmoxService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    const run = () => void this.watchdog().catch(() => undefined);
    this.first = setTimeout(run, 10_000);
    this.timer = setInterval(run, 60_000);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  targets(): Record<string, string> {
    return parseTargets(this.config.checkTargets, this.config.proxmox.url);
  }

  /** Probe all targets, or only `only`. Unknown names throw a Dutch message. */
  async check(only?: string): Promise<ServiceCheckResult[]> {
    const targets = this.targets();
    const wanted = only?.toLowerCase();
    if (wanted && !targets[wanted])
      throw new Error(
        `Onbekend doel. Bekende doelen: ${Object.keys(targets).join(", ")}`,
      );
    const names = wanted ? [wanted] : Object.keys(targets);
    return Promise.all(
      names.map(async (name) => ({
        name,
        ...(await probe(targets[name] ?? "")),
      })),
    );
  }

  /** Recent alerts, newest first, with whether each is still open. */
  alerts(limit = 10): AlertInfo[] {
    const state = this.store.data;
    return state.alerts.slice(0, limit).map((alert) => ({
      ...alert,
      severity: alert.severity as AlertInfo["severity"],
      open: !!state.active[alert.key],
    }));
  }

  private raise({ key, severity, title, detail }: Raise): void {
    const state = this.store.data;
    const alert = {
      id: newId(),
      key,
      severity,
      title,
      detail: detail || "",
      at: new Date().toISOString(),
    };
    state.alerts.unshift(alert);
    state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
    if (severity !== "info") state.active[key] = true;
    this.store.emit({
      topic: "jarvis/alerts",
      payload: { type: "alert", ...alert },
    });
    this.store.save();
  }

  private resolve(key: string): void {
    delete this.store.data.active[key];
  }

  /** One watchdog round: Proxmox transitions, then service reachability. */
  async watchdog(): Promise<void> {
    const state = this.store.data;
    const firstRun = !state.watch.guests;
    if (this.proxmox.configured) {
      try {
        const [guests, nodes, storage] = await Promise.all([
          this.proxmox.resources("vm"),
          this.proxmox.rawNodes(),
          this.proxmox.resources("storage"),
        ]);
        this.resolve("proxmox-down");
        const previous = state.watch.guests || {};
        const next: Record<string, string> = {};
        for (const guest of guests) {
          next[String(guest.vmid)] = guest.status ?? "";
          const was = previous[String(guest.vmid)];
          if (firstRun || was === undefined) continue;
          const key = `vm-${guest.vmid}-stopped`;
          if (was === "running" && guest.status !== "running")
            this.raise({
              key,
              severity: "warning",
              title: `${guest.name} is gestopt`,
              detail: `VM ${guest.vmid} draaide net nog.`,
            });
          if (was !== "running" && guest.status === "running") {
            this.resolve(key);
            this.raise({
              key,
              severity: "info",
              title: `${guest.name} draait weer`,
              detail: `VM ${guest.vmid} is gestart.`,
            });
          }
        }
        state.watch.guests = next;
        for (const node of nodes) {
          const key = `node-${node.node}`;
          if (node.status !== "online" && !state.active[key])
            this.raise({
              key,
              severity: "critical",
              title: `Node ${node.node} is offline`,
              detail: "De Proxmox-node reageert niet.",
            });
          if (node.status === "online") this.resolve(key);
        }
        for (const store of storage) {
          if (!((store.maxdisk ?? 0) > 0)) continue;
          const used = (store.disk ?? 0) / (store.maxdisk ?? 1);
          const key = `storage-${store.storage}`;
          if (used >= 0.9 && !state.active[key])
            this.raise({
              key,
              severity: "warning",
              title: `Opslag ${store.storage} zit bijna vol`,
              detail: `${Math.round(used * 100)}% in gebruik.`,
            });
          if (used < 0.85) this.resolve(key);
        }
      } catch {
        if (!state.active["proxmox-down"])
          this.raise({
            key: "proxmox-down",
            severity: "warning",
            title: "Proxmox is niet bereikbaar",
            detail: "De API gaf geen antwoord.",
          });
        state.watch.guests ||= {};
      }
    }
    for (const result of await this.check()) {
      const key = `service-${result.name}`;
      if (result.ok) {
        state.watch.down[result.name] = 0;
        if (state.active[key]) {
          this.resolve(key);
          this.raise({
            key,
            severity: "info",
            title: `${result.name} is weer bereikbaar`,
            detail: `Antwoordt weer binnen ${result.ms} ms.`,
          });
        }
      } else {
        state.watch.down[result.name] =
          (state.watch.down[result.name] || 0) + 1;
        // Two misses in a row, so one slow request does not wake anyone.
        if ((state.watch.down[result.name] ?? 0) >= 2 && !state.active[key])
          this.raise({
            key,
            severity: "warning",
            title: `${result.name} reageert niet`,
            detail: result.detail,
          });
      }
    }
    this.store.save();
  }
}
