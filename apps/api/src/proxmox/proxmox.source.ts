import {
  integer,
  schema,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { ProxmoxService, guestView } from "./proxmox.service.js";

const READ_ONLY_TOOLS: Record<string, string> = {
  status:
    "Health of the Proxmox host itself: online or not, CPU, memory and uptime of each node. It does NOT list virtual machines; use proxmox_guests for that.",
  nodes:
    "The Proxmox nodes (hosts) with CPU, memory and uptime. It does NOT list virtual machines; use proxmox_guests for that.",
  guests:
    'List ALL virtual machines and containers with name, id, status (running or stopped), CPU and memory. Use it for "welke VMs draaien er", "hoeveel VMs", "hoe druk zijn de VMs", and to find a VM id by name.',
  storage: "Disk storage of Proxmox: every storage with used and total size.",
  tasks:
    "Recent Proxmox tasks such as backups, starts and stops, with their result.",
};
const ACTIONS = ["start", "stop", "shutdown", "reboot"] as const;
const ACTION_RE = /^proxmox_(start|stop|shutdown|reboot)_guest$/;
const FAILED = "Proxmox unavailable, misconfigured, or request failed";

const vmid = integer(1, Number.MAX_SAFE_INTEGER);

/** The Proxmox tools. Start/stop style actions are verified here by watching the guest. */
@ToolSourceProvider()
export class ProxmoxSource implements ToolSource {
  readonly source = "proxmox";
  /** Pause between verification polls; tests shorten it. */
  verifyDelayMs = 500;

  constructor(private readonly proxmox: ProxmoxService) {}

  definitions(): ToolDefinition[] {
    const enabled = this.proxmox.configured;
    return [
      ...Object.entries(READ_ONLY_TOOLS).map(
        ([name, description]): ToolDefinition => ({
          name: `proxmox_${name}`,
          description,
          parameters: schema(),
          risk: "READ_ONLY",
          enabled,
        }),
      ),
      {
        name: "proxmox_guest_status",
        description:
          "Detailed live status of ONE virtual machine or container, by its numeric vmid (find the id with proxmox_guests)",
        parameters: schema({ vmid }),
        risk: "READ_ONLY",
        enabled,
      },
      ...ACTIONS.map((action): ToolDefinition => ({
        name: `proxmox_${action}_guest`,
        description: `${action} a Proxmox VM or LXC container`,
        parameters: schema({ vmid }),
        risk: "CONFIRM",
        enabled,
      })),
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { signal: AbortSignal },
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case "proxmox_status":
        case "proxmox_nodes":
          return { ok: true, result: await this.proxmox.status(call.signal) };
        case "proxmox_guests":
          return { ok: true, result: await this.guests(call.signal) };
        case "proxmox_storage":
          return {
            ok: true,
            result: { storage: await this.proxmox.rawStorage(call.signal) },
          };
        case "proxmox_tasks":
          return {
            ok: true,
            result: { tasks: await this.proxmox.tasks(call.signal) },
          };
        default:
          return await this.guestTool(name, Number(args.vmid), call.signal);
      }
    } catch {
      return { ok: false, error: FAILED };
    }
  }

  private async guests(signal: AbortSignal) {
    const guests = await this.proxmox.guestViews(signal);
    const running = guests.filter((g) => g.status === "running");
    const stopped = guests.filter((g) => g.status !== "running");
    return {
      summary: {
        total: guests.length,
        running: running.length,
        stopped: stopped.length,
        runningNames: running.map((g) => g.name),
        stoppedNames: stopped.map((g) => g.name),
        hint: "Noem de aantallen. Noem namen alleen als erom gevraagd wordt, en dan hooguit drie.",
      },
      guests,
    };
  }

  private async guestTool(
    name: string,
    id: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const guests = await this.proxmox.resources("vm", signal);
    const target = guests.find((g) => g.vmid === id);
    if (
      !target ||
      !["qemu", "lxc"].includes(target.type ?? "") ||
      !/^[a-zA-Z0-9_-]+$/.test(target.node ?? "")
    )
      return { ok: false, error: "Guest not found" };
    const prefix = `/nodes/${encodeURIComponent(target.node ?? "")}/${target.type}/${id}/status/`;
    if (name === "proxmox_guest_status")
      return {
        ok: true,
        result: guestView({
          ...target,
          ...(await this.proxmox.request<object>(
            `${prefix}current`,
            "GET",
            signal,
          )),
        }),
      };
    const action = ACTION_RE.exec(name)?.[1];
    if (!action) return { ok: false, error: "Unknown tool" };
    const result: ToolResult = {
      ok: true,
      result: {
        vmid: id,
        node: target.node,
        type: target.type,
        task: await this.proxmox.request(`${prefix}${action}`, "POST", signal),
        accepted: true,
      },
    };
    return this.verify(name, id, result, signal);
  }

  /** Watch the guest for a moment: did it reach the state the action asked for? */
  private async verify(
    name: string,
    id: number,
    result: ToolResult,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const expected =
      name === "proxmox_start_guest"
        ? "running"
        : name === "proxmox_reboot_guest"
          ? null
          : "stopped";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt)
        await new Promise((resolve) => setTimeout(resolve, this.verifyDelayMs));
      const observed = await this.execute(
        "proxmox_guest_status",
        { vmid: id },
        { signal },
      );
      const state = (observed.result as { status?: string } | undefined)
        ?.status;
      if (expected && observed.ok && state === expected)
        return {
          ...result,
          accepted: true,
          verified: true,
          status: "verified",
        };
    }
    return {
      ...result,
      accepted: true,
      verified: null,
      status: "accepted_unverified",
      note:
        name === "proxmox_reboot_guest"
          ? "Reboot completion cannot be inferred from a running state; check the task and uptime"
          : "Requested state has not yet been observed; check the task status",
    };
  }
}
