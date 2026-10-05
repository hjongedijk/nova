import { Injectable } from "@nestjs/common";
import type {
  ProxmoxGuestInfo,
  ProxmoxNodeInfo,
  ProxmoxStatusInfo,
  ProxmoxStorageInfo,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { requestJson } from "../core/http/http-json.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import { StateService } from "../core/state/state.service.js";

/** A resource as /cluster/resources and /nodes list it (only what NOVA reads). */
export interface PveResource {
  vmid?: number;
  node?: string;
  type?: string;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  storage?: string;
  plugintype?: string;
  disk?: number;
  maxdisk?: number;
}

/** A guest as the tools show it. */
export interface GuestView {
  vmid: number | undefined;
  name: string | undefined;
  node: string | undefined;
  type: string | undefined;
  label: string;
  status: string | undefined;
  cpuUsagePercent: number;
  memoryUsed: number;
  memoryTotal: number;
  uptime: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function guestView(g: PveResource): GuestView {
  return {
    vmid: g.vmid,
    name: g.name,
    node: g.node,
    type: g.type,
    label: g.type === "qemu" ? "QEMU VM" : "LXC container",
    status: g.status,
    cpuUsagePercent: Math.round((g.cpu || 0) * 1000) / 10,
    memoryUsed: g.mem || 0,
    memoryTotal: g.maxmem || 0,
    uptime: g.uptime || 0,
  };
}

/** Talks to the Proxmox API and keeps NOVA's picture of Proxmox (state + MQTT status) current. */
@Injectable()
export class ProxmoxService {
  constructor(
    private readonly config: NovaConfig,
    private readonly state: StateService,
    private readonly mqtt: MqttService,
  ) {}

  get configured(): boolean {
    const p = this.config.proxmox;
    return !!(p.url && p.tokenId && p.tokenSecret);
  }

  /** Raw call; the answer is Proxmox's `data` field. Errors carry no details on purpose. */
  async request<T = unknown>(
    endpoint: string,
    method = "GET",
    signal?: AbortSignal,
  ): Promise<T> {
    const p = this.config.proxmox;
    if (!this.configured) throw new Error("Proxmox not configured");
    let target: URL;
    try {
      target = new URL(`${p.url}/api2/json${endpoint}`);
    } catch {
      throw new Error("Invalid configuration");
    }
    if (!["https:", "http:"].includes(target.protocol))
      throw new Error("Invalid protocol");
    try {
      const response = await requestJson<{ data?: T }>(target.toString(), {
        method,
        signal,
        timeoutMs: 15000,
        insecureTls: !p.verifyTls,
        headers: { authorization: `PVEAPIToken=${p.tokenId}=${p.tokenSecret}` },
      });
      if (
        response.status >= 400 ||
        !response.data ||
        typeof response.data !== "object" ||
        !Object.hasOwn(response.data, "data")
      )
        throw new Error("Proxmox request failed");
      return response.data.data as T;
    } catch {
      throw new Error("Proxmox request failed");
    }
  }

  private async track<T>(
    work: () => Promise<T>,
    extra?: (value: T) => Record<string, unknown>,
  ): Promise<T> {
    try {
      const value = await work();
      this.state.update("proxmox", { online: true, ...extra?.(value) });
      this.mqtt.publish("jarvis/status/proxmox", { online: true }, true);
      return value;
    } catch (error) {
      this.state.update("proxmox", { online: false });
      this.mqtt.publish("jarvis/status/proxmox", { online: false }, true);
      throw error;
    }
  }

  /** Raw resources of one kind (vm or storage), for the watchdog and the briefing. */
  resources(type: "vm" | "storage", signal?: AbortSignal) {
    return this.request<PveResource[]>(
      `/cluster/resources?type=${type}`,
      "GET",
      signal,
    );
  }

  rawNodes(signal?: AbortSignal) {
    return this.request<PveResource[]>("/nodes", "GET", signal);
  }

  tasks(signal?: AbortSignal) {
    return this.track(async () =>
      (await this.request<unknown[]>("/cluster/tasks", "GET", signal)).slice(
        0,
        25,
      ),
    );
  }

  /** Health of each node, as proxmox_status / proxmox_nodes answer. */
  status(signal?: AbortSignal): Promise<ProxmoxStatusInfo> {
    return this.track(
      async () => {
        const nodes: ProxmoxNodeInfo[] = (await this.rawNodes(signal)).map(
          (n) => ({
            node: n.node ?? "",
            status: n.status ?? "",
            cpu: {
              usagePercent: Math.round((n.cpu || 0) * 1000) / 10,
              cores: n.maxcpu || 0,
            },
            memory: {
              usedGB: round1((n.mem || 0) / 1073741824),
              totalGB: round1((n.maxmem || 0) / 1073741824),
              usagePercent: n.maxmem
                ? round1(((n.mem ?? 0) / n.maxmem) * 100)
                : 0,
            },
            uptimeSeconds: n.uptime || 0,
          }),
        );
        return {
          nodes,
          totalNodes: nodes.length,
          onlineNodes: nodes.filter((n) => n.status === "online").length,
          offlineNodes: nodes.filter((n) => n.status !== "online").length,
        };
      },
      (status) => ({ nodes: status.totalNodes }),
    );
  }

  /** All guests in the tool format (with label, cpuUsagePercent, ...). */
  guestViews(signal?: AbortSignal): Promise<GuestView[]> {
    return this.track(
      async () => (await this.resources("vm", signal)).map(guestView),
      (guests) => ({
        guestsRunning: guests.filter((g) => g.status === "running").length,
      }),
    );
  }

  /** Guests for the dashboard, sorted by id. */
  async guests(signal?: AbortSignal): Promise<ProxmoxGuestInfo[]> {
    return (await this.guestViews(signal))
      .map((g) => ({
        vmid: g.vmid ?? 0,
        name: g.name ?? "",
        type: g.type ?? "",
        status: g.status ?? "",
        cpu: g.cpuUsagePercent,
        memoryUsed: g.memoryUsed,
        memoryTotal: g.memoryTotal,
        uptime: g.uptime,
      }))
      .sort((a, b) => a.vmid - b.vmid);
  }

  /** Raw storage resources (what proxmox_storage answers). */
  rawStorage(signal?: AbortSignal): Promise<PveResource[]> {
    return this.track(() => this.resources("storage", signal));
  }

  /** Storage with a known size for the dashboard, biggest first. */
  async storage(signal?: AbortSignal): Promise<ProxmoxStorageInfo[]> {
    return (await this.rawStorage(signal))
      .filter((s) => (s.maxdisk ?? 0) > 0)
      .map((s) => ({
        name: s.storage ?? "",
        type: s.plugintype,
        used: s.disk ?? 0,
        total: s.maxdisk ?? 0,
      }))
      .sort((a, b) => b.total - a.total);
  }
}
