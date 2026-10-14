import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Injectable, Optional } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { requestJson } from "../core/http/http-json.js";
import { sanitize } from "../core/security/sanitize.js";
import { NodeRedFlowRevisions } from "../settings/node-red-flow-revisions.service.js";
import {
  ToolSourceProvider,
  type ToolDefinition,
  type ToolPlan,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";

import {
  ID,
  validId,
  validTime,
  validTimezone,
  flowRows,
  projectBriefingSchedules,
  type Flow,
  type BriefingSchedule,
} from "./node-red-briefing.js";

const NAME = "node_red_briefing_schedule";
const ERROR =
  "Node-RED-briefing kan niet worden gewijzigd. Vernieuw de lijst en bevestig opnieuw.";
type Snapshot = { rev: string; flows: Flow[] };
function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const flows = flowRows(row.flows);
  return typeof row.rev === "string" &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(row.rev) &&
    sanitize(row.rev) === row.rev &&
    flows
    ? { rev: row.rev, flows }
    : null;
}

/** Changes only the clock/timezone of an existing fixed NOVA briefing node. */
@ToolSourceProvider()
@Injectable()
export class NodeRedBriefingSource implements ToolSource {
  readonly source = "node-red";
  private readonly fingerprintKey = randomBytes(32);
  private fingerprint(flows: Flow[]): string {
    return createHmac("sha256", this.fingerprintKey)
      .update(JSON.stringify(flows))
      .digest("hex");
  }
  constructor(
    private readonly config: NovaConfig,
    @Optional() private readonly revisions?: NodeRedFlowRevisions,
  ) {}
  private base(): string | null {
    try {
      const url = new URL(this.config.nodeRedUrl);
      return ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        ["node-red", "localhost", "127.0.0.1"].includes(
          url.hostname.toLowerCase(),
        )
        ? url.origin
        : null;
    } catch {
      return null;
    }
  }
  private headers(): Record<string, string> {
    return {
      "Node-RED-API-Version": "v2",
      ...(this.config.nodeRedAdminToken
        ? { authorization: `Bearer ${this.config.nodeRedAdminToken}` }
        : {}),
    };
  }
  definitions(): ToolDefinition[] {
    return this.base()
      ? [
          {
            name: NAME,
            description:
              "Change only the daily time and IANA timezone of one existing NOVA briefing node after fresh DANGEROUS confirmation. Empty time disables its daily trigger and keeps stable-ID event triggers. Does not create flows or executable nodes.",
            risk: "DANGEROUS",
            allowStandingApproval: false,
            timeoutMs: 15000,
            parameters: {
              type: "object",
              properties: {
                nodeId: { type: "string", pattern: ID.source },
                time: {
                  type: "string",
                  pattern: "^(?:|(?:[01]\\d|2[0-3]):[0-5]\\d)$",
                },
                timezone: { type: "string", minLength: 1, maxLength: 80 },
              },
              required: ["nodeId", "time", "timezone"],
              additionalProperties: false,
            },
          },
        ]
      : [];
  }
  private async read(base: string, signal?: AbortSignal): Promise<Snapshot> {
    const response = await requestJson(`${base}/flows`, {
      headers: this.headers(),
      signal,
      timeoutMs: 4000,
    });
    const result = snapshot(response.data);
    if (response.status < 200 || response.status >= 300 || !result)
      throw new Error(ERROR);
    return result;
  }
  private target(
    current: Snapshot,
    nodeId: string,
  ): { schedule: BriefingSchedule; node: Flow } | null {
    const node = current.flows.find((row) => row.id === nodeId);
    if (!node || typeof node.z !== "string") return null;
    const schedule = projectBriefingSchedules(current.flows, node.z).find(
      (row) => row.id === nodeId,
    );
    return schedule ? { schedule, node } : null;
  }
  async prepare(
    name: string,
    args: Record<string, unknown>,
    call?: { signal: AbortSignal },
  ): Promise<ToolPlan | { error: string }> {
    const base = this.base();
    if (
      name !== NAME ||
      !base ||
      Object.keys(args).some(
        (key) => !["nodeId", "time", "timezone"].includes(key),
      ) ||
      !validId(args.nodeId) ||
      !validTime(args.time) ||
      !validTimezone(args.timezone)
    )
      return { error: ERROR };
    try {
      const current = await this.read(base, call?.signal);
      const target = this.target(current, args.nodeId);
      if (!target) return { error: ERROR };
      const kind = target.schedule.kind;
      const label = `${kind === "morning_briefing" ? "Ochtendbriefing" : "Avondoverzicht"}: ${args.time ? `dagelijks om ${args.time} (${args.timezone})` : `alleen gebeurtenissen (${args.timezone}); dagelijkse planning uit`}`;
      return {
        risk: "DANGEROUS",
        args: {
          nodeId: args.nodeId,
          time: args.time,
          timezone: args.timezone,
          kind,
          tabId: target.node.z,
          revision: current.rev,
          fingerprint: this.fingerprint(current.flows),
          label,
        },
      };
    } catch {
      return { error: ERROR };
    }
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { signal: AbortSignal },
  ): Promise<ToolResult> {
    const base = this.base();
    if (
      name !== NAME ||
      !base ||
      !validId(args.nodeId) ||
      !validTime(args.time) ||
      !validTimezone(args.timezone) ||
      typeof args.revision !== "string" ||
      typeof args.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(args.fingerprint)
    )
      return { ok: false, error: ERROR };
    let accepted = false;
    try {
      const current = await this.read(base, call.signal);
      const target = this.target(current, args.nodeId);
      if (
        current.rev !== args.revision ||
        this.fingerprint(current.flows) !== args.fingerprint ||
        !target ||
        target.schedule.kind !== args.kind ||
        target.node.z !== args.tabId
      )
        return { ok: false, error: ERROR };
      const updated = current.flows.map((row) =>
        row === target.node
          ? { ...row, time: args.time, timezone: args.timezone }
          : row,
      );
      const deployed = await requestJson(`${base}/flows`, {
        method: "POST",
        headers: { ...this.headers(), "Node-RED-Deployment-Type": "flows" },
        body: { rev: current.rev, flows: updated },
        signal: call.signal,
        timeoutMs: 6000,
      });
      accepted = deployed.status >= 200 && deployed.status < 300;
      const revision =
        deployed.data && typeof deployed.data === "object"
          ? (deployed.data as { rev?: unknown }).rev
          : null;
      if (
        deployed.status < 200 ||
        deployed.status >= 300 ||
        typeof revision !== "string" ||
        revision === current.rev
      )
        return { ok: false, accepted, verified: false, error: ERROR };
      const after = await this.read(base, call.signal);
      if (after.rev !== revision || !isDeepStrictEqual(after.flows, updated))
        return {
          ok: false,
          accepted: true,
          verified: false,
          error:
            "Node-RED-briefing gewijzigd, maar de controle is niet geslaagd. Vernieuw de lijst.",
        };
      let historyWarning: string | undefined;
      try {
        this.revisions?.recordVerifiedChange(
          { revision: current.rev, flows: current.flows },
          { revision: after.rev, flows: after.flows },
        );
      } catch {
        historyWarning =
          "Briefing gewijzigd, maar lokale versiegeschiedenis kon niet worden opgeslagen.";
      }
      return {
        ok: true,
        accepted: true,
        verified: true,
        result: `${target.schedule.kind === "morning_briefing" ? "Ochtendbriefing" : "Avondoverzicht"}: ${args.time ? `dagelijks om ${args.time} (${args.timezone})` : `alleen gebeurtenissen (${args.timezone}); dagelijkse planning uit`}`,
        ...(historyWarning ? { historyWarning } : {}),
      };
    } catch {
      return {
        ok: false,
        ...(accepted ? { accepted: true, verified: false } : {}),
        error: ERROR,
      };
    }
  }
}
