import { projectBriefingInventory } from "../dashboard/node-red-briefing.js";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import crypto from "node:crypto";
import { requestJson } from "../core/http/http-json.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import type { AuditEntry } from "../core/audit/audit.service.js";

const MAX_BACKUP_BYTES = 800_000;
const MAX_FLOW_NODES = 5_000;
const SENSITIVE_FLOW_KEY =
  /credential|authorization|password|secret|token|api.?key|headers/i;

export interface NodeRedFlowSnapshot {
  revision: string;
  flows: Record<string, unknown>[];
}

export function normalizeNodeRedBackupFlows(
  value: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_FLOW_NODES)
    throw new ServiceUnavailableException(
      "De flowback-up heeft een ongeldige omvang.",
    );
  const ids = new Set<string>();
  const hasSecretField = (candidate: unknown, depth = 0): boolean => {
    if (depth > 30) return true;
    if (Array.isArray(candidate))
      return candidate.some((item) => hasSecretField(item, depth + 1));
    if (!candidate || typeof candidate !== "object") return false;
    return Object.entries(candidate).some(
      ([key, item]) =>
        SENSITIVE_FLOW_KEY.test(key) || hasSecretField(item, depth + 1),
    );
  };
  const flows = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ServiceUnavailableException(
        "De flowback-up bevat een ongeldig node.",
      );
    const node = item as Record<string, unknown>;
    if (
      typeof node.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(node.id) ||
      ids.has(node.id) ||
      typeof node.type !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(node.type)
    )
      throw new ServiceUnavailableException(
        "De flowback-up bevat ongeldige of dubbele node-ID's.",
      );
    ids.add(node.id);
    const clean = sanitize(node);
    if (hasSecretField(node) || JSON.stringify(clean) !== JSON.stringify(node))
      throw new ServiceUnavailableException(
        "De flowback-up bevat mogelijk geheimen. Verwijder credential- en geheime velden eerst.",
      );
    return structuredClone(node);
  });
  if (Buffer.byteLength(JSON.stringify(flows), "utf8") > MAX_BACKUP_BYTES)
    throw new ServiceUnavailableException(
      "De Node-RED-flowback-up is groter dan 800 kB.",
    );
  return flows;
}

export interface NodeRedFlowWriteResult {
  ok: boolean;
  revision?: string;
  error?: string;
}

export interface NodeRedFlowTab {
  id: string;
  label: string;
  disabled: boolean;
  nodeCount: number;
  briefings?: {
    id: string;
    kind: "morning_briefing" | "evening_review";
    time: string;
    timezone: string;
  }[];
  lastRun: string | null;
  lastError: string | null;
}

export interface NodeRedPaletteState {
  revision: string;
  modules: { name: string; installed: boolean; version: string | null }[];
}

/** Add only projected execution metadata; never return the logged payload. */
export function projectNodeRedFlowRuns<T extends { id: string }>(
  flows: T[],
  entries: AuditEntry[],
): (T & { lastRun: string | null; lastError: string | null })[] {
  const latest = new Map<string, { at: string; error: string | null }>();
  for (const entry of entries) {
    if (
      entry.tool !== "node_red_flow" ||
      ["pending", "denied", "expired"].includes(entry.confirmation ?? "")
    )
      continue;
    const args =
      entry.arguments && typeof entry.arguments === "object"
        ? (entry.arguments as Record<string, unknown>)
        : {};
    const flowId = args.flow;
    if (typeof flowId !== "string" || latest.has(flowId)) continue;
    const result =
      entry.result && typeof entry.result === "object"
        ? (entry.result as Record<string, unknown>)
        : {};
    latest.set(flowId, {
      at: entry.timestamp,
      error: result.ok === false ? "Flow mislukt." : null,
    });
  }
  return flows.map((flow) => {
    const run = latest.get(flow.id);
    return { ...flow, lastRun: run?.at ?? null, lastError: run?.error ?? null };
  });
}

/** PIN-gated, projected Node-RED flow inventory. Never returns executable node data. */
@Injectable()
export class NodeRedManagement {
  private paletteChanging = false;

  constructor(private readonly config: NovaConfig) {}

  private baseUrl(): URL {
    let base: URL;
    try {
      base = new URL(this.config.nodeRedUrl);
    } catch {
      throw new ServiceUnavailableException("Node-RED-adres is ongeldig.");
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      !["node-red", "localhost", "127.0.0.1"].includes(
        base.hostname.toLowerCase(),
      )
    )
      throw new ServiceUnavailableException(
        "Node-RED is buiten het lokale netwerk ingesteld.",
      );
    return base;
  }

  private flowHeaders(): Record<string, string> {
    return {
      "Node-RED-API-Version": "v2",
      ...(this.config.nodeRedAdminToken
        ? { authorization: `Bearer ${this.config.nodeRedAdminToken}` }
        : {}),
    };
  }

  private allowedPaletteModules(): string[] {
    let raw: unknown;
    try {
      raw = JSON.parse(this.config.nodeRedPaletteAllowlist);
    } catch {
      throw new ServiceUnavailableException(
        "Node-RED-palette-toegang is ongeldig ingesteld.",
      );
    }
    if (
      !Array.isArray(raw) ||
      raw.length > 20 ||
      raw.some(
        (name) =>
          typeof name !== "string" ||
          !/^node-red-(?:contrib|node)-[a-z0-9][a-z0-9._-]{0,99}$/.test(name),
      ) ||
      new Set(raw).size !== raw.length
    )
      throw new ServiceUnavailableException(
        "Node-RED-palette-toegang is ongeldig ingesteld.",
      );
    return raw;
  }

  private async installedPalette(): Promise<
    Map<
      string,
      {
        version: string | null;
        sets: {
          id: string | null;
          name: string | null;
          enabled: boolean | null;
          loaded: boolean | null;
          types: string[];
        }[];
      }
    >
  > {
    let response;
    try {
      response = await requestJson<unknown>(`${this.baseUrl().origin}/nodes`, {
        headers: this.flowHeaders(),
        timeoutMs: 5000,
        maxResponseBytes: 300_000,
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Node-RED-palette is niet beschikbaar.",
      );
    }
    if (
      response.status !== 200 ||
      !Array.isArray(response.data) ||
      response.data.length > 2000
    )
      throw new ServiceUnavailableException(
        "Node-RED-palette kon niet veilig worden gelezen.",
      );
    const modules = new Map<
      string,
      {
        version: string | null;
        sets: {
          id: string | null;
          name: string | null;
          enabled: boolean | null;
          loaded: boolean | null;
          types: string[];
        }[];
      }
    >();
    for (const item of response.data) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new ServiceUnavailableException(
          "Node-RED-palette gaf ongeldige gegevens.",
        );
      const row = item as Record<string, unknown>;
      if (
        typeof row.module !== "string" ||
        row.module.length > 120 ||
        (row.id !== undefined &&
          (typeof row.id !== "string" || row.id.length > 180)) ||
        (row.name !== undefined &&
          (typeof row.name !== "string" || row.name.length > 120)) ||
        (row.enabled !== undefined && typeof row.enabled !== "boolean") ||
        (row.loaded !== undefined && typeof row.loaded !== "boolean") ||
        !Array.isArray(row.types) ||
        row.types.length > 100 ||
        row.types.some((type) => typeof type !== "string" || type.length > 120)
      )
        throw new ServiceUnavailableException(
          "Node-RED-palette gaf ongeldige gegevens.",
        );
      const current = modules.get(row.module) ?? { version: null, sets: [] };
      if (
        typeof row.version === "string" &&
        /^[0-9A-Za-z.+_-]{1,60}$/.test(row.version)
      )
        current.version = row.version;
      current.sets.push({
        id: typeof row.id === "string" ? row.id : null,
        name: typeof row.name === "string" ? row.name : null,
        enabled: typeof row.enabled === "boolean" ? row.enabled : null,
        loaded: typeof row.loaded === "boolean" ? row.loaded : null,
        types: [...(row.types as string[])].sort(),
      });
      modules.set(row.module, current);
    }
    return modules;
  }

  async paletteState(): Promise<NodeRedPaletteState> {
    const allowed = this.allowedPaletteModules();
    const installed = await this.installedPalette();
    const canonical = [...installed]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [
        name,
        value.version,
        value.sets.map((set) => JSON.stringify(set)).sort(),
      ]);
    return {
      revision: crypto
        .createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex"),
      modules: allowed.map((name) => ({
        name,
        installed: installed.has(name),
        version: installed.get(name)?.version ?? null,
      })),
    };
  }

  async changePalette(
    name: string,
    install: boolean,
    expectedRevision: string,
  ): Promise<NodeRedPaletteState> {
    if (this.paletteChanging)
      throw new ServiceUnavailableException(
        "Er is al een Node-RED-palettewijziging bezig. Laad opnieuw.",
      );
    this.paletteChanging = true;
    try {
      if (!this.allowedPaletteModules().includes(name))
        throw new ServiceUnavailableException(
          "Deze Node-RED-module is niet toegestaan.",
        );
      const before = await this.paletteState();
      if (before.revision !== expectedRevision)
        throw new ServiceUnavailableException(
          "Node-RED-palette is gewijzigd. Laad opnieuw.",
        );
      if (
        before.modules.find((row) => row.name === name)?.installed === install
      )
        throw new ServiceUnavailableException(
          "Node-RED-palette is gewijzigd. Laad opnieuw.",
        );
      let response;
      try {
        response = await requestJson<unknown>(
          `${this.baseUrl().origin}/nodes${install ? "" : `/${name}`}`,
          {
            method: install ? "POST" : "DELETE",
            headers: this.flowHeaders(),
            ...(install ? { body: { module: name } } : {}),
            timeoutMs: 30_000,
            maxResponseBytes: 100_000,
            signal: AbortSignal.timeout(31_000),
          },
        );
      } catch {
        throw new ServiceUnavailableException(
          "Node-RED-wijziging heeft geen bevestigde uitkomst. Controleer de palette.",
        );
      }
      if (response.status !== (install ? 200 : 204))
        throw new ServiceUnavailableException(
          "Node-RED heeft de palettewijziging geweigerd.",
        );
      let after: NodeRedPaletteState;
      try {
        after = await this.paletteState();
      } catch {
        throw new ServiceUnavailableException(
          "Palettewijziging is mogelijk uitgevoerd maar kon niet worden gecontroleerd.",
        );
      }
      if (after.modules.find((row) => row.name === name)?.installed !== install)
        throw new ServiceUnavailableException(
          "Node-RED heeft de palettewijziging niet bevestigd.",
        );
      return after;
    } finally {
      this.paletteChanging = false;
    }
  }

  async flowSnapshot(): Promise<NodeRedFlowSnapshot> {
    const base = this.baseUrl();
    let response;
    try {
      response = await requestJson<unknown>(`${base.origin}/flows`, {
        headers: this.flowHeaders(),
        timeoutMs: 5000,
        maxResponseBytes: MAX_BACKUP_BYTES,
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Node-RED-flowconfiguratie is niet beschikbaar.",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ServiceUnavailableException(
        "Node-RED vraagt beheertoegang voor de flowback-up.",
      );
    if (response.status < 200 || response.status >= 300)
      throw new ServiceUnavailableException(
        "Node-RED-flowconfiguratie kon niet worden gelezen.",
      );
    const body = response.data;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { rev?: unknown }).rev !== "string" ||
      !(body as { rev: string }).rev ||
      !Array.isArray((body as { flows?: unknown }).flows)
    )
      throw new ServiceUnavailableException(
        "Node-RED ondersteunt geen versiegebonden flowback-up.",
      );
    return {
      revision: (body as { rev: string }).rev,
      flows: normalizeNodeRedBackupFlows((body as { flows: unknown[] }).flows),
    };
  }

  async writeFlowSnapshot(
    expectedRevision: string,
    flowsValue: unknown,
  ): Promise<NodeRedFlowWriteResult> {
    if (this.config.nodeRedAdminToken.length < 32)
      return {
        ok: false,
        error: "Stel NODE_RED_ADMIN_TOKEN met flows.write in.",
      };
    let flows: Record<string, unknown>[];
    try {
      flows = normalizeNodeRedBackupFlows(flowsValue);
    } catch {
      return {
        ok: false,
        error: "De flowback-up is ongeldig of bevat geheime velden.",
      };
    }
    let current: NodeRedFlowSnapshot;
    try {
      current = await this.flowSnapshot();
    } catch {
      return {
        ok: false,
        error: "Flowrevisie kon niet opnieuw worden gecontroleerd.",
      };
    }
    if (current.revision !== expectedRevision)
      return {
        ok: false,
        error: "Node-RED-flows zijn gewijzigd; laad de back-up opnieuw.",
      };
    const base = this.baseUrl();
    let deployed;
    try {
      deployed = await requestJson<{ rev?: unknown }>(`${base.origin}/flows`, {
        method: "POST",
        headers: {
          ...this.flowHeaders(),
          "Node-RED-Deployment-Type": "flows",
        },
        body: { rev: expectedRevision, flows },
        timeoutMs: 8000,
        maxResponseBytes: 100_000,
        signal: AbortSignal.timeout(9000),
      });
    } catch {
      return {
        ok: false,
        error:
          "Flowimport heeft geen bevestigde uitkomst; controleer Node-RED.",
      };
    }
    if (deployed.status === 409)
      return {
        ok: false,
        error: "Node-RED-flows zijn gewijzigd; laad de back-up opnieuw.",
      };
    if (deployed.status < 200 || deployed.status >= 300)
      return { ok: false, error: "Node-RED heeft de flowimport geweigerd." };
    let after: NodeRedFlowSnapshot;
    try {
      after = await this.flowSnapshot();
    } catch {
      return {
        ok: false,
        error:
          "Flowimport is mogelijk uitgevoerd maar kon niet worden gecontroleerd.",
      };
    }
    if (JSON.stringify(after.flows) !== JSON.stringify(flows))
      return {
        ok: false,
        error: "Node-RED heeft de flowimport niet volledig opgeslagen.",
      };
    return { ok: true, revision: after.revision };
  }

  editorUrl(): string | null {
    try {
      const editor = new URL(this.config.nodeRedEditorUrl);
      if (
        !["http:", "https:"].includes(editor.protocol) ||
        editor.username ||
        editor.password
      )
        return null;
      return `${editor.origin}${editor.pathname.replace(/\/$/, "")}`;
    } catch {
      return null;
    }
  }

  runnableFlowId(tabId: string): string | null {
    if (this.config.nodeRedFlowToken.length < 32) return null;
    return this.allowlistedFlowId(tabId);
  }

  canSetFlowEnabled(tabId: string): boolean {
    return (
      this.config.nodeRedAdminToken.length >= 32 &&
      this.allowlistedFlowId(tabId) !== null
    );
  }

  availableTemplates(tabId: string): string[] {
    if (
      this.config.nodeRedAdminToken.length < 32 ||
      this.config.nodeRedEventToken.length < 32 ||
      !this.allowlistedFlowId(tabId)
    )
      return [];
    return [
      "alert_on_error",
      "alert_on_offline",
      "morning_briefing",
      "evening_review",
      "daily_reminder",
    ];
  }

  private allowlistedFlowId(tabId: string): string | null {
    try {
      const raw: unknown = JSON.parse(this.config.nodeRedFlowAllowlist);
      if (!Array.isArray(raw) || raw.length > 50) return null;
      const matches: string[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        if (
          row.tabId === tabId &&
          typeof row.id === "string" &&
          /^[a-z0-9][a-z0-9_-]{0,47}$/.test(row.id)
        )
          matches.push(row.id);
      }
      return matches.length === 1 ? matches[0]! : null;
    } catch {
      return null;
    }
  }

  async listFlows(): Promise<{
    revision: string | null;
    flows: NodeRedFlowTab[];
    truncated: boolean;
  }> {
    let base: URL;
    try {
      base = new URL(this.config.nodeRedUrl);
    } catch {
      throw new ServiceUnavailableException("Node-RED-adres is ongeldig.");
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      !["node-red", "localhost", "127.0.0.1"].includes(
        base.hostname.toLowerCase(),
      )
    )
      throw new ServiceUnavailableException(
        "Node-RED is buiten het lokale netwerk ingesteld.",
      );

    let response;
    try {
      response = await requestJson<unknown>(`${base.origin}/flows`, {
        headers: {
          "Node-RED-API-Version": "v2",
          ...(this.config.nodeRedAdminToken
            ? { authorization: `Bearer ${this.config.nodeRedAdminToken}` }
            : {}),
        },
        timeoutMs: 4000,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException("Node-RED reageert niet.");
    }
    if (response.status === 401 || response.status === 403)
      throw new ServiceUnavailableException(
        "Node-RED vraagt beheer-toegang. Stel NODE_RED_ADMIN_TOKEN in en herstart NOVA.",
      );
    if (response.status < 200 || response.status >= 300)
      throw new ServiceUnavailableException("Flowoverzicht niet beschikbaar.");
    const body = response.data;
    const flows = Array.isArray(body)
      ? body
      : body &&
          typeof body === "object" &&
          Array.isArray((body as { flows?: unknown }).flows)
        ? (body as { flows: unknown[] }).flows
        : null;
    if (!flows)
      throw new ServiceUnavailableException(
        "Node-RED gaf een ongeldig flowoverzicht.",
      );

    const tabIds = new Set(
      flows.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        return row.type === "tab" && typeof row.id === "string" ? [row.id] : [];
      }),
    );
    const nodeCounts = new Map<string, number>();
    for (const item of flows) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.z === "string" && tabIds.has(row.z))
        nodeCounts.set(row.z, (nodeCounts.get(row.z) ?? 0) + 1);
    }
    const briefingInventory = projectBriefingInventory(flows);
    const tabs = flows.flatMap((item): NodeRedFlowTab[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (
        row.type !== "tab" ||
        typeof row.id !== "string" ||
        !row.id ||
        row.id.length > 128
      )
        return [];
      const label =
        typeof row.label === "string" && row.label.trim()
          ? sanitize(row.label).slice(0, 120)
          : "Naamloze flow";
      return [
        {
          id: row.id,
          label,
          disabled: row.disabled === true,
          nodeCount: nodeCounts.get(row.id) ?? 0,
          briefings: briefingInventory.get(row.id) ?? [],
          lastRun: null,
          lastError: null,
        },
      ];
    });
    const revision =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as { rev?: unknown }).rev === "string"
        ? (body as { rev: string }).rev.slice(0, 256)
        : null;
    return {
      revision,
      flows: tabs.slice(0, 200),
      truncated: tabs.length > 200,
    };
  }
}
