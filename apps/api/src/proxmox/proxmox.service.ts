import { Injectable, Optional } from "@nestjs/common";
import type {
  ProxmoxGuestInfo,
  ProxmoxNodeInfo,
  ProxmoxStatusInfo,
  ProxmoxStorageInfo,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ManagedTargetsAccessStore } from "../settings/managed-targets-access.store.js";
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

export interface ProxmoxTaskView {
  type: string;
  status: "running" | "OK" | "failed";
  starttime?: number;
  endtime?: number;
}

const SAFE_TASK_TYPES = new Set([
  "qmstart",
  "qmstop",
  "qmshutdown",
  "qmreboot",
  "pctstart",
  "pctstop",
  "pctshutdown",
  "vzdump",
]);

function taskView(value: unknown): ProxmoxTaskView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const type =
    typeof task.type === "string" && SAFE_TASK_TYPES.has(task.type)
      ? task.type
      : "other";
  const time = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  return {
    type,
    status:
      task.status === "OK"
        ? "OK"
        : task.status === "running" ||
            (task.status === undefined && task.endtime === undefined)
          ? "running"
          : "failed",
    starttime: time(task.starttime),
    endtime: time(task.endtime),
  };
}

/** Storage tools expose only documented identifiers, status and capacity fields. */
function storageView(value: unknown): PveResource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resource = value as Record<string, unknown>;
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
      ? value
      : undefined;
  const capacity = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const storage = identifier(resource.storage);
  if (!storage) return null;
  return {
    storage,
    node: identifier(resource.node),
    type: "storage",
    plugintype: identifier(resource.plugintype),
    status:
      resource.status === "available" || resource.status === "unavailable"
        ? resource.status
        : "unknown",
    disk: capacity(resource.disk),
    maxdisk: capacity(resource.maxdisk),
  };
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
    @Optional() private readonly targetAccess?: ManagedTargetsAccessStore,
  ) {}

  get configured(): boolean {
    const p = this.config.proxmox;
    return !!(p.url && p.tokenId && p.tokenSecret);
  }

  allowsGuest(node: string, vmid: number | string): boolean {
    return this.targetAccess?.allowsProxmoxGuest(node, vmid) ?? true;
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

  /** Recent task summaries; upstream status text and metadata stay private. */
  tasks(signal?: AbortSignal): Promise<ProxmoxTaskView[]> {
    if (this.targetAccess?.get().mode === "allowlist")
      return Promise.resolve([] as ProxmoxTaskView[]);
    return this.track(async () => {
      const tasks = await this.request<unknown>(
        "/cluster/tasks",
        "GET",
        signal,
      );
      if (!Array.isArray(tasks)) throw new Error("Invalid Proxmox task list");
      return tasks.slice(0, 25).flatMap((task) => {
        const projected = taskView(task);
        return projected ? [projected] : [];
      });
    });
  }

  /** Health of each node, as proxmox_status / proxmox_nodes answer. */
  status(signal?: AbortSignal): Promise<ProxmoxStatusInfo> {
    return this.track(
      async () => {
        const nodes: ProxmoxNodeInfo[] = (await this.rawNodes(signal))
          .filter(
            (item) =>
              this.targetAccess?.allows("proxmoxNodeIds", item.node ?? "") ??
              true,
          )
          .map((n) => ({
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
          }));
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
      async () =>
        (await this.resources("vm", signal))
          .filter(
            (item) =>
              this.targetAccess?.allowsProxmoxGuest(
                item.node ?? "",
                item.vmid ?? "",
              ) ?? true,
          )
          .map(guestView),
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

  /** Bounded storage projection shared by tools and the dashboard. */
  rawStorage(signal?: AbortSignal): Promise<PveResource[]> {
    return this.track(async () => {
      const resources: unknown = await this.resources("storage", signal);
      if (!Array.isArray(resources))
        throw new Error("Invalid storage response");
      return resources
        .flatMap((value: unknown) => {
          const item = storageView(value);
          return item ? [item] : [];
        })
        .filter(
          (item) =>
            this.targetAccess?.allows("proxmoxNodeIds", item.node ?? "") ??
            true,
        );
    });
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
