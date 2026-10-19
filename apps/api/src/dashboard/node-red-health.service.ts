import { Injectable } from "@nestjs/common";
import { requestJson } from "../core/http/http-json.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { AlertsFeed } from "./alerts-feed.service.js";

export interface NodeRedHealthReport {
  online: boolean;
  flowCount: number | null;
  /** Node-RED's standard Admin API has no last-runtime-error endpoint. */
  lastError: string | null;
  lastErrorAvailable: boolean;
  lastErrorFlowId: string | null;
}

const unavailable = (): NodeRedHealthReport => ({
  online: false,
  flowCount: null,
  lastError: null,
  lastErrorAvailable: false,
  lastErrorFlowId: null,
});

@Injectable()
export class NodeRedHealth {
  private cached: { report: NodeRedHealthReport; expiresAt: number } | null =
    null;
  private runtimeError: string | null = null;
  private runtimeErrorFlowId: string | null = null;
  private previousAvailability = true;
  private failedChecks = 0;
  private failedSince: number | null = null;
  private inFlight: Promise<NodeRedHealthReport> | null = null;
  constructor(
    private readonly config: NovaConfig,
    private readonly alerts?: AlertsFeed,
  ) {}

  private cache(
    report: NodeRedHealthReport,
    ttlMs: number,
  ): NodeRedHealthReport {
    const now = Date.now();
    if (report.online) {
      this.failedChecks = 0;
      this.failedSince = null;
    } else {
      this.failedChecks += 1;
      this.failedSince ??= now;
    }
    // One slow inventory read is not an outage. Announce recovery only after
    // an outage was actually announced, including failures during startup.
    const confirmed =
      report.online ||
      (this.failedChecks >= 3 && now - this.failedSince! >= 30_000);
    if (confirmed && this.previousAvailability !== report.online) {
      this.alerts?.recordNodeRedAlert({
        title: report.online
          ? "Node-RED weer bereikbaar"
          : "Node-RED reageert niet",
        detail: report.online
          ? "De verbinding met Node-RED is hersteld."
          : "NOVA kan Node-RED niet bereiken.",
        severity: report.online ? "info" : "critical",
      });
    }
    if (confirmed) this.previousAvailability = report.online;
    this.cached = { report, expiresAt: Date.now() + ttlMs };
    return report;
  }

  recordRuntimeError(_message: string, flowId?: string): void {
    this.runtimeError = "Flowfout gemeld door Node-RED.";
    this.runtimeErrorFlowId = flowId ?? null;
    if (this.cached)
      this.cached = {
        ...this.cached,
        report: {
          ...this.cached.report,
          lastError: this.runtimeError,
          lastErrorAvailable: true,
          lastErrorFlowId: this.runtimeErrorFlowId,
        },
      };
  }

  async report(): Promise<NodeRedHealthReport> {
    if (this.cached && this.cached.expiresAt > Date.now())
      return this.cached.report;
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async probe(): Promise<NodeRedHealthReport> {
    try {
      const base = new URL(this.config.nodeRedUrl);
      const allowedHosts = new Set(["node-red", "localhost", "127.0.0.1"]);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        !allowedHosts.has(base.hostname.toLowerCase())
      )
        throw new Error("Node-RED URL is outside the local service allowlist");
      const target = `${base.origin}/flows`;
      const response = await requestJson<unknown[] | { flows?: unknown }>(
        target,
        {
          headers: {
            "Node-RED-API-Version": "v2",
            ...(this.config.nodeRedAdminToken
              ? { authorization: `Bearer ${this.config.nodeRedAdminToken}` }
              : {}),
          },
          timeoutMs: 2500,
          signal: AbortSignal.timeout(3000),
        },
      );
      if (response.status === 401 || response.status === 403) {
        const report: NodeRedHealthReport = {
          online: true,
          flowCount: null,
          lastError: this.runtimeError,
          lastErrorAvailable: this.runtimeError !== null,
          lastErrorFlowId: this.runtimeErrorFlowId,
        };
        return this.cache(report, 5_000);
      }
      if (response.status < 200 || response.status >= 300 || !response.data)
        throw new Error("Node-RED flow inventory unavailable");
      const body = response.data;
      const flows = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray(body.flows)
          ? body.flows
          : null;
      if (!flows) throw new Error("Unexpected Node-RED flow response");
      const report: NodeRedHealthReport = {
        online: true,
        flowCount: flows.filter(
          (flow) =>
            flow &&
            typeof flow === "object" &&
            (flow as Record<string, unknown>).type === "tab",
        ).length,
        lastError: this.runtimeError,
        lastErrorAvailable: this.runtimeError !== null,
        lastErrorFlowId: this.runtimeErrorFlowId,
      };
      return this.cache(report, 30_000);
    } catch {
      const report: NodeRedHealthReport = {
        ...unavailable(),
        lastError: this.runtimeError,
        lastErrorAvailable: this.runtimeError !== null,
        lastErrorFlowId: this.runtimeErrorFlowId,
      };
      return this.cache(report, 5_000);
    }
  }
}
