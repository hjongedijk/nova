/** A VM or container as the dashboard shows it. */
export interface ProxmoxGuestInfo {
  vmid: number;
  name: string;
  type: string;
  status: string;
  /** CPU use in percent (one decimal), null when unknown. */
  cpu: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  uptime: number | null;
}

/** A Proxmox storage with a known size. */
export interface ProxmoxStorageInfo {
  name: string;
  type: string | undefined;
  used: number;
  total: number;
}

export interface ProxmoxNodeInfo {
  node: string;
  status: string;
  cpu: { usagePercent: number; cores: number };
  memory: { usedGB: number; totalGB: number; usagePercent: number };
  uptimeSeconds: number;
}

/** Health of the Proxmox host(s): what proxmox_status answers. */
export interface ProxmoxStatusInfo {
  nodes: ProxmoxNodeInfo[];
  totalNodes: number;
  onlineNodes: number;
  offlineNodes: number;
}

export interface TimerInfo {
  id: string;
  label: string;
  /** ISO time the timer fires. */
  fireAt: string;
  remainingSeconds: number;
}

/** List name -> the first items (as text). */
export type ListsOverview = Record<string, string[]>;

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertInfo {
  id: string;
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** ISO time the alert was raised. */
  at: string;
  /** Still open (not recovered). */
  open: boolean;
}

/** Result of probing one service. */
export interface ServiceCheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

/**
 * Something NOVA should tell the user without being asked. `jarvis/events/timer` carries
 * `timer_fired`, `jarvis/alerts` carries `alert`.
 */
export interface InfrastructureEvent {
  topic: "jarvis/events/timer" | "jarvis/alerts";
  payload: Record<string, unknown>;
}
