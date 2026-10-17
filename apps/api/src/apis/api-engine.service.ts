import { Injectable, Logger } from "@nestjs/common";
import type { Risk } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ApiRegistry } from "./api-registry.js";
import { ApiVault } from "./api-vault.js";
import {
  RISK_RANK,
  maxRisk,
  type ApiIntegration,
  type ApiOperation,
  type AuthHint,
  type AuthScheme,
  type DiscoveryReport,
} from "./api.types.js";
import {
  AdapterError,
  buildRequest,
  decodeResponse,
  missingParams,
  type BuiltRequest,
} from "./adapters.js";
import { forgetTokens, resolveAuth } from "./auth.js";
import { discover } from "./discovery.js";
import { ingestDocs } from "./ingest.js";
import { ApiHttpClient, ApiHttpError } from "./safe-http.js";
import { newOperation, slug } from "./spec-util.js";

const DAY = 86_400_000;
export const MODEL_RESULT_CHARS = 12_000;

export interface ConnectInput {
  baseUrl: string;
  name?: string;
  local?: boolean;
  token?: string;
  credentialRef?: string;
  authType?:
    | "none"
    | "bearer"
    | "basic"
    | "header"
    | "query"
    | "oauth2_client_credentials";
  headerName?: string;
  queryName?: string;
  tokenUrl?: string;
  docsUrl?: string;
}

export interface CallResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  code?: string;
  truncated?: boolean;
  request: { method: string; url: string };
  redirectedTo?: string;
  authRejected?: boolean;
  durationMs: number;
}

/** Keep a decoded response within what a model can read; arrays lose whole items, never mid-item. */
export function shrink(
  data: unknown,
  limit = MODEL_RESULT_CHARS,
): { data: unknown; truncated: boolean } {
  const text = JSON.stringify(data) ?? "";
  if (text.length <= limit) return { data, truncated: false };
  if (Array.isArray(data)) {
    const kept: unknown[] = [];
    let size = 2;
    for (const item of data) {
      const length = (JSON.stringify(item) ?? "").length + 1;
      if (size + length > limit) break;
      kept.push(item);
      size += length;
    }
    return {
      data: {
        items: kept,
        note: `[truncated by NOVA: ${kept.length} of ${data.length} items shown]`,
      },
      truncated: true,
    };
  }
  return {
    data: `${text.slice(0, limit)} [truncated by NOVA: ${text.length} characters in total]`,
    truncated: true,
  };
}

/** What the model, the settings page and the audit may see of an integration: never a credential, only whether one exists. */
export function describeIntegration(i: ApiIntegration, vault?: ApiVault) {
  const byRisk = { READ_ONLY: 0, SAFE: 0, CONFIRM: 0, DANGEROUS: 0 } as Record<
    Risk,
    number
  >;
  for (const op of i.operations) byRisk[op.risk]++;
  return {
    id: i.id,
    name: i.name,
    protocol: i.protocol,
    baseUrl: i.baseUrl,
    local: i.local,
    status: i.status,
    auth: {
      type: i.auth.type,
      ...(i.auth.type === "header" || i.auth.type === "query"
        ? { name: i.auth.name }
        : {}),
      credentialStored:
        i.auth.type === "none" ? null : (vault?.has(i.auth.ref) ?? true),
    },
    operations: i.operations.length,
    enabledOperations: i.operations.filter(
      (o) => o.enabled && o.status !== "gone",
    ).length,
    byRisk,
    degradedOperations: i.operations
      .filter((o) => o.status === "degraded")
      .map((o) => o.id),
    specSource: i.source,
    specVersion: i.specVersion,
    learnedAt: i.learnedAt,
    lastTest: i.lastTest ?? null,
    counters: i.counters,
    notes: i.notes.slice(0, 8),
    needs: i.needs,
    nextCheckAt: new Date(i.maintenance.nextDueAt).toISOString(),
  };
}

export function describeOperation(op: ApiOperation) {
  return {
    id: op.id,
    summary: op.summary,
    method: op.method,
    path: op.path,
    risk: op.risk,
    provenRisk: op.floor,
    enabled: op.enabled,
    status: op.status,
    routine: op.routine,
    params: op.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      type: p.schema.type ?? "any",
    })),
    body: op.body
      ? { contentType: op.body.contentType, required: op.body.required }
      : undefined,
    hints: op.hints,
    pendingChange: op.pending
      ? "a changed definition waits for your approval"
      : undefined,
    stats: op.stats,
  };
}

@Injectable()
export class ApiEngine {
  private readonly log = new Logger("API engine");
  http: ApiHttpClient;

  constructor(
    readonly registry: ApiRegistry,
    readonly vault: ApiVault,
    config: NovaConfig,
  ) {
    this.http = new ApiHttpClient({ ownPort: config.port });
  }

  /** Tests replace the client to control DNS. */
  useHttp(client: ApiHttpClient): void {
    this.http = client;
  }

  integration(id: string): ApiIntegration {
    const found = this.registry.get(id);
    if (!found)
      throw new AdapterError(
        `No integration called '${id}'. Use api_list to see the connected ones.`,
      );
    return found;
  }

  // -------------------------------------------------------------- connecting

  private schemeFor(
    input: ConnectInput,
    ref: string | undefined,
    hint: AuthHint | undefined,
  ): AuthScheme | null {
    const type =
      input.authType ??
      (hint && hint.type !== "unknown" && hint.type !== "none"
        ? hint.type
        : undefined);
    if (type === "none") return { type: "none" };
    if (!ref) return hint?.type === "none" || !hint ? { type: "none" } : null;
    switch (type) {
      case "bearer":
        return { type: "bearer", ref };
      case "basic":
        return { type: "basic", ref };
      case "header":
        return {
          type: "header",
          name:
            input.headerName ??
            (hint?.type === "header" ? hint.name : "X-API-Key"),
          ref,
        };
      case "query":
        return {
          type: "query",
          name:
            input.queryName ?? (hint?.type === "query" ? hint.name : "api_key"),
          ref,
        };
      case "oauth2_client_credentials": {
        const tokenUrl =
          input.tokenUrl ??
          (hint?.type === "oauth2_client_credentials" ? hint.tokenUrl : "");
        return tokenUrl
          ? {
              type: "oauth2_client_credentials",
              tokenUrl,
              ref,
              ...(hint?.type === "oauth2_client_credentials" && hint.scope
                ? { scope: hint.scope }
                : {}),
            }
          : null;
      }
      default:
        return null;
    }
  }

  /** Try the usual ways to send a credential until a read-only probe is accepted. */
  private async detectAuth(
    i: ApiIntegration,
    ref: string,
    secret: string,
  ): Promise<AuthScheme | null> {
    const candidates: AuthScheme[] = [
      { type: "bearer", ref },
      { type: "header", name: "X-API-Key", ref },
      ...(secret.includes(":") ? [{ type: "basic", ref } as AuthScheme] : []),
      { type: "header", name: "Authorization", ref, prefix: "Token " },
      { type: "query", name: "api_key", ref },
    ];
    for (const scheme of candidates) {
      const trial = { ...i, auth: scheme };
      const outcome = await this.runProbe(trial);
      if (outcome && outcome.status !== undefined && outcome.status < 300)
        return scheme;
      if (outcome?.code === "blocked_address") return null;
    }
    return null;
  }

  async connect(
    input: ConnectInput,
    signal?: AbortSignal,
  ): Promise<{
    integration: ApiIntegration;
    report: DiscoveryReport;
    verified: boolean | null;
  }> {
    let url: URL;
    try {
      url = new URL(input.baseUrl.trim());
    } catch {
      throw new AdapterError(
        "That is not a valid URL. Give the full address, for example https://api.example.com/v1.",
      );
    }
    if (!/^https?:$/.test(url.protocol))
      throw new AdapterError(
        "Only http(s) URLs are supported (WebSocket and gRPC are not).",
      );
    let token = input.token?.trim() || undefined;
    let authType = input.authType;
    if (url.username || url.password) {
      token ??= `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      authType ??= "basic";
      url.username = "";
      url.password = "";
    }
    let queryName = input.queryName;
    for (const [key, value] of [...url.searchParams.entries()])
      if (
        !token &&
        value &&
        /^(?:api[_-]?key|apikey|access[_-]?token|token|key|auth|secret|sig|signature)$/i.test(
          key,
        )
      ) {
        // A key in the address must not be stored or shown: it moves to the vault and is sent as a query parameter.
        token = value;
        authType ??= "query";
        queryName ??= key;
      }
    url.search = "";
    url.hash = "";
    const local = input.local === true;
    const clean = url.toString().replace(/\/$/, "");
    const existing = this.registry
      .list()
      .find(
        (x) => x.baseUrl === clean || (input.name && x.id === slug(input.name)),
      );
    const id =
      existing?.id ??
      this.freeId(
        slug(
          input.name ??
            url.hostname.replace(/^(?:api|www)\./, "").split(".")[0] ??
            "api",
        ),
      );
    let ref = input.credentialRef;
    if (ref && !this.vault.has(ref))
      throw new AdapterError("That credential reference does not exist.");
    if (token) {
      if (
        existing &&
        existing.auth.type !== "none" &&
        this.vault.has(existing.auth.ref) &&
        this.vault.hostOf(existing.auth.ref) === url.host
      ) {
        this.vault.replace(existing.auth.ref, token);
        ref = existing.auth.ref;
      } else ref = this.vault.put(token, id, url.host);
    }
    if (ref && !this.vault.bindHost(ref, url.host))
      throw new AdapterError(
        `This credential belongs to ${this.vault.hostOf(ref)} and is never sent to another host.`,
      );
    const provisional: AuthScheme = ref
      ? (this.schemeFor({ ...input, authType, queryName }, ref, undefined) ?? {
          type: "bearer",
          ref,
        })
      : { type: "none" };
    const shell: ApiIntegration = {
      id,
      name: input.name?.trim().slice(0, 60) || id,
      protocol: "rest",
      baseUrl: clean,
      local,
      auth: provisional,
      operations: [],
      specVersion: 1,
      source: "none",
      status: "needs_info",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      counters: { ok: 0, fail: 0 },
      maintenance: {
        nextDueAt: Date.now() + DAY,
        nextDiscoveryAt: Date.now() + 7 * DAY,
        failStreak: 0,
        authFailStreak: 0,
      },
      notes: [],
      needs: [],
      rateLimit: 60,
    };
    let auth;
    try {
      auth = await resolveAuth(
        shell,
        provisional,
        this.vault,
        this.http,
        signal,
      );
    } catch (error) {
      throw this.redactError(error);
    }
    const report = await discover({
      baseUrl: clean,
      local,
      integrationId: id,
      auth,
      docsUrl: input.docsUrl,
      http: this.http,
      signal,
    });
    const hint = report.auth;
    const scheme =
      this.schemeFor({ ...input, authType, queryName }, ref, hint) ??
      provisional;
    const next: ApiIntegration = {
      ...shell,
      protocol: report.protocol ?? "rest",
      baseUrl: report.baseUrl ?? clean,
      auth: scheme,
      operations: report.operations,
      source: report.source ?? "none",
      status: report.ok ? "ready" : "needs_info",
      notes: report.notes.slice(0, 10),
      needs: report.needs,
      name:
        input.name?.trim().slice(0, 60) ||
        (report.title && report.title !== "API"
          ? report.title.slice(0, 60)
          : id),
    };
    next.probe = this.pickProbe(next)?.id;
    let verified: boolean | null = null;
    if (
      ref &&
      !authType &&
      !(hint && hint.type !== "unknown" && hint.type !== "none")
    ) {
      const detected = await this.detectAuth(
        next,
        ref,
        token ?? this.vault.get(ref) ?? "",
      );
      if (detected) {
        next.auth = detected;
        next.notes.push(
          `Authentication worked as '${detected.type}${detected.type === "header" || detected.type === "query" ? `:${detected.name}` : ""}'.`,
        );
      }
    }
    if (report.ok || next.operations.length) {
      const outcome = await this.runProbe(next, signal);
      verified = outcome ? outcome.ok : null;
      next.lastTest = this.testRecord(outcome, next.probe);
      if (outcome?.authRejected) {
        next.status = "credentials_expired";
        next.needs.push(
          "The credentials were rejected (HTTP 401/403). Check the token and how it must be sent.",
        );
      }
    }
    if (!report.ok && report.needs.length === 0)
      next.needs.push("Nothing machine-readable was found.");
    this.registry.save(next);
    return { integration: next, report, verified };
  }

  private freeId(wanted: string): string {
    let id = wanted;
    for (let n = 2; this.registry.get(id) || id === "call"; n++)
      id = `${wanted}_${n}`;
    return id;
  }

  // --------------------------------------------------------------- executing

  private redactError(error: unknown): Error {
    const message = error instanceof Error ? error.message : "Request failed";
    const out = new AdapterError(this.vault.redact(message).slice(0, 300));
    return out;
  }

  /** One request to the API for an operation (or a synthetic probe). Never throws for network problems. */
  async execute(
    i: ApiIntegration,
    built: BuiltRequest,
    signal?: AbortSignal,
  ): Promise<CallResult & { raw?: { contentType: string; body: string } }> {
    const started = Date.now();
    const request = { method: built.method, url: built.url };
    try {
      const auth = await resolveAuth(i, i.auth, this.vault, this.http, signal);
      const response = await this.http.request({
        url: built.url,
        method: built.method,
        integrationId: i.id,
        headers: built.headers,
        body: built.body,
        credentials: auth,
        local: i.local,
        rateLimit: i.rateLimit,
        signal,
      });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        request: { method: built.method, url: this.vault.redact(response.url) },
        truncated: response.truncated,
        redirectedTo: response.redirectedTo,
        authRejected: response.status === 401 || response.status === 403,
        durationMs: Date.now() - started,
        raw: { contentType: response.contentType, body: response.body },
      };
    } catch (error) {
      const code = error instanceof ApiHttpError ? error.code : "network";
      return {
        ok: false,
        code,
        error: this.redactError(error).message,
        request,
        durationMs: Date.now() - started,
      };
    }
  }

  async call(
    integrationId: string,
    operationId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options: { readOnlyOnly?: boolean } = {},
  ): Promise<CallResult> {
    const i = this.integration(integrationId);
    const op = i.operations.find((o) => o.id === operationId);
    if (!op)
      throw new AdapterError(
        `'${integrationId}' has no operation '${operationId}'. Use api_describe to list them.`,
      );
    if (!op.enabled || op.status === "gone")
      throw new AdapterError(
        `Operation '${operationId}' is ${op.status === "gone" ? "no longer offered by the API" : "switched off"}${op.hints.length ? ` (${op.hints[0]})` : ""}.`,
      );
    if (options.readOnlyOnly && op.risk !== "READ_ONLY")
      throw new AdapterError("Only read-only operations may run here.");
    const missing = missingParams(op, args);
    if (missing.length)
      throw new AdapterError(
        `Missing required parameter(s): ${missing.join(", ")}.`,
      );
    let built: BuiltRequest;
    try {
      built = buildRequest(i, op, args);
    } catch (error) {
      throw error instanceof AdapterError
        ? error
        : new AdapterError(
            "The request could not be built from these parameters.",
          );
    }
    const result = await this.execute(i, built, signal);
    const decoded = result.raw
      ? decodeResponse(
          i,
          op,
          result.status ?? 0,
          result.raw.contentType,
          result.raw.body,
        )
      : undefined;
    delete result.raw;
    const final: CallResult = {
      ...result,
      ok: result.ok && decoded?.ok !== false,
      ...(decoded ? { data: this.vault.redactDeep(decoded.data) } : {}),
      ...(decoded?.error && !result.error
        ? { error: this.vault.redact(decoded.error) }
        : {}),
    };
    if (final.data !== undefined) {
      const shrunk = shrink(final.data);
      final.data = shrunk.data;
      final.truncated = final.truncated || shrunk.truncated;
    }
    this.record(i, op, final);
    return final;
  }

  private record(
    i: ApiIntegration,
    op: ApiOperation,
    result: CallResult,
  ): void {
    const stats = op.stats;
    stats.lastAt = new Date().toISOString();
    if (result.status !== undefined) stats.lastStatus = result.status;
    if (result.ok) {
      stats.ok++;
      stats.failStreak = 0;
      i.counters.ok++;
      if (
        result.redirectedTo &&
        i.protocol === "rest" &&
        op.method === "GET" &&
        op.risk === "READ_ONLY" &&
        !op.path.includes("{")
      ) {
        const prefix = new URL(i.baseUrl).pathname.replace(/\/$/, "");
        const moved = result.redirectedTo.startsWith(prefix)
          ? result.redirectedTo.slice(prefix.length)
          : result.redirectedTo;
        if (moved && moved !== op.path) {
          op.hints.push(
            `path moved from ${op.path} to ${moved} (server redirect); updated`,
          );
          op.path = moved;
          op.hash = newOperation({ ...op, risk: op.risk }).hash;
        }
      }
    } else {
      stats.fail++;
      stats.failStreak++;
      i.counters.fail++;
    }
    try {
      this.registry.flush();
    } catch {
      this.log.warn("Could not save integration statistics");
    }
  }

  // ---------------------------------------------------------------- testing

  pickProbe(i: ApiIntegration): ApiOperation | undefined {
    const usable = i.operations.filter(
      (o) =>
        o.enabled &&
        o.status !== "gone" &&
        o.risk === "READ_ONLY" &&
        !o.params.some((p) => p.required) &&
        !o.body?.required,
    );
    if (i.protocol === "graphql")
      return usable.find((o) => o.gql?.selection) ?? usable[0];
    if (i.protocol === "jsonrpc")
      return (
        usable.find((o) =>
          /^(?:rpc\.discover|system\.listMethods)$/.test(o.path),
        ) ?? usable[0]
      );
    return usable.sort(
      (a, b) =>
        Number(a.path.includes("health")) - Number(b.path.includes("health")) ||
        a.path.length - b.path.length,
    )[0];
  }

  /** A read-only request that proves reachability and credentials, without touching any mutating operation. */
  async runProbe(
    i: ApiIntegration,
    signal?: AbortSignal,
    specific?: ApiOperation,
    args: Record<string, unknown> = {},
  ): Promise<(CallResult & { operation?: string }) | null> {
    const op = specific ?? this.pickProbe(i);
    let built: BuiltRequest;
    if (op) {
      if (op.risk !== "READ_ONLY")
        throw new AdapterError("api_test only runs read-only operations.");
      try {
        built = buildRequest(i, op, args);
      } catch {
        return null;
      }
    } else if (i.protocol === "graphql")
      built = {
        url: i.baseUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      };
    else if (i.protocol === "soap")
      built = {
        url: `${i.baseUrl.split("?")[0]}?wsdl`,
        method: "GET",
        headers: {},
      };
    else if (i.protocol === "jsonrpc")
      built = {
        url: i.baseUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
      };
    else built = { url: i.baseUrl, method: "GET", headers: {} };
    const result = await this.execute(i, built, signal);
    delete result.raw;
    if (op && result.status !== undefined) {
      op.stats.lastStatus = result.status;
      op.stats.lastAt = new Date().toISOString();
    }
    // A JSON-RPC probe answering "method not found" still proves the endpoint is alive.
    if (!op && i.protocol === "jsonrpc" && result.status === 200)
      result.ok = true;
    return { ...result, ...(op ? { operation: op.id } : {}) };
  }

  testRecord(
    outcome: (CallResult & { operation?: string }) | null,
    probe?: string,
  ): NonNullable<ApiIntegration["lastTest"]> {
    const at = new Date().toISOString();
    if (!outcome)
      return {
        at,
        ok: false,
        note: "No read-only request could be built for a test.",
      };
    return {
      at,
      ok: outcome.ok,
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      operation: outcome.operation ?? probe ?? "(connectivity)",
      note: outcome.ok
        ? "Read-only probe succeeded."
        : outcome.authRejected
          ? "The credentials were rejected (HTTP 401/403)."
          : (outcome.error ?? `HTTP ${outcome.status}`).slice(0, 160),
    };
  }

  /** api_test: only read-only probes. Updates the stored test record. */
  async test(
    id: string,
    operation?: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    const i = this.integration(id);
    const specific = operation
      ? i.operations.find((o) => o.id === operation)
      : undefined;
    if (operation && !specific)
      throw new AdapterError(`No operation '${operation}'.`);
    const outcome = await this.runProbe(i, signal, specific, args);
    i.lastTest = this.testRecord(outcome, i.probe);
    if (outcome?.ok && i.status !== "needs_info") i.status = "ready";
    this.registry.save(i);
    return { integration: i, outcome };
  }

  // ----------------------------------------------------- refresh / docs / admin

  /** Re-discover and diff. Read-only operations are healed inside the spec; mutating changes wait for approval. */
  async refresh(
    id: string,
    options: { applyPending?: boolean } = {},
    signal?: AbortSignal,
  ) {
    const i = this.integration(id);
    const auth = await resolveAuth(
      i,
      i.auth,
      this.vault,
      this.http,
      signal,
    ).catch(() => undefined);
    const report = await discover({
      baseUrl: i.baseUrl,
      local: i.local,
      integrationId: i.id,
      auth,
      http: this.http,
      signal,
    });
    if (!report.ok) {
      return {
        integration: i,
        changed: false,
        available: false,
        added: [] as string[],
        removed: [] as string[],
        changedOps: [] as string[],
        pendingApproval: [] as string[],
        notes: [
          "Re-discovery found no machine-readable description; the stored spec is unchanged.",
          ...report.needs.slice(0, 2),
        ],
      };
    }
    const diff = this.merge(i, report.operations, {
      applyPending: options.applyPending === true,
      authoritative: true,
    });
    if (
      report.baseUrl &&
      new URL(report.baseUrl).origin === new URL(i.baseUrl).origin &&
      report.protocol === i.protocol
    )
      i.baseUrl = report.baseUrl;
    i.source = report.source ?? i.source;
    if (diff.added.length || diff.removed.length || diff.changedOps.length) {
      i.specVersion++;
      i.learnedAt = new Date().toISOString();
    }
    i.maintenance.nextDiscoveryAt = Date.now() + 7 * DAY;
    this.registry.save(i);
    return {
      integration: i,
      available: true,
      changed: Boolean(
        diff.added.length ||
        diff.removed.length ||
        diff.changedOps.length ||
        diff.pendingApproval.length,
      ),
      ...diff,
      notes: report.notes,
    };
  }

  /** Merge freshly learned operations into the stored ones. */
  merge(
    i: ApiIntegration,
    fresh: ApiOperation[],
    {
      applyPending,
      authoritative,
    }: { applyPending: boolean; authoritative: boolean },
  ) {
    const added: string[] = [];
    const removed: string[] = [];
    const changedOps: string[] = [];
    const pendingApproval: string[] = [];
    const known = new Map(i.operations.map((o) => [o.id, o]));
    const seen = new Set<string>();
    for (const op of fresh) {
      seen.add(op.id);
      const old = known.get(op.id);
      if (!old) {
        const mutating = op.risk !== "READ_ONLY";
        i.operations.push({
          ...op,
          enabled: authoritative ? !mutating : true,
          hints: [
            ...op.hints,
            ...(authoritative && mutating
              ? ["new operation: switched off until you approve it"]
              : []),
          ],
        });
        added.push(op.id);
        continue;
      }
      if (old.status === "gone") {
        old.status = "ok";
        old.hints = old.hints.filter((h) => !h.startsWith("no longer"));
      }
      const deprecated = op.status === "deprecated";
      if (deprecated && old.status !== "deprecated") {
        old.status = "deprecated";
        old.hints.push("marked deprecated by the API");
      }
      if (old.hash === op.hash) continue;
      const safe = old.risk === "READ_ONLY" && op.floor === "READ_ONLY";
      if (safe || applyPending || old.pending?.hash === op.hash) {
        const risk = maxRisk(old.risk, op.floor);
        Object.assign(old, {
          ...op,
          risk,
          floor: op.floor,
          enabled: old.enabled,
          routine: old.routine && risk === "READ_ONLY",
          stats: old.stats,
          hints: op.hints,
          status: old.status === "degraded" ? "degraded" : op.status,
        });
        delete old.pending;
        changedOps.push(op.id);
      } else {
        old.pending = { ...op };
        pendingApproval.push(op.id);
      }
    }
    if (authoritative)
      for (const old of i.operations)
        if (!seen.has(old.id) && old.status !== "gone") {
          old.status = "gone";
          old.enabled = false;
          old.hints.push("no longer offered by the API");
          removed.push(old.id);
        }
    i.probe = this.pickProbe(i)?.id;
    return { added, removed, changedOps, pendingApproval };
  }

  /** User-provided documentation, spec, collection or example requests. */
  async attachDocs(id: string, text: string, signal?: AbortSignal) {
    const i = this.integration(id);
    const outcome = ingestDocs(text, new URL(i.baseUrl));
    if (!outcome || !outcome.operations.length)
      return {
        ok: false as const,
        error:
          "Nothing usable found. Accepted: OpenAPI/Swagger JSON, Postman collection v2.1, HAR, GraphQL introspection JSON, OpenRPC/JSON-RPC method list, WSDL, curl commands, or lines like 'GET /v1/items/{id}'. YAML specs are not supported; convert them to JSON.",
      };
    const notes = [...outcome.notes];
    if (outcome.baseUrl) {
      try {
        const found = new URL(outcome.baseUrl);
        const mine = new URL(i.baseUrl);
        if (found.origin !== mine.origin) {
          notes.push(
            `The material points at another host (${found.host}); NOVA keeps using ${mine.host} and never sends credentials elsewhere. Add that API as its own integration if you want it.`,
          );
          if (
            outcome.kind === "curl" ||
            outcome.kind === "postman" ||
            outcome.kind === "har"
          )
            outcome.operations = [];
        } else if (outcome.kind === "wsdl" || outcome.kind === "openapi")
          i.baseUrl = found.toString().replace(/\/$/, "");
      } catch {
        /* keep */
      }
    }
    if (!outcome.operations.length)
      return {
        ok: false as const,
        error: `No operation for ${new URL(i.baseUrl).host} found in the material. ${notes.join(" ")}`,
      };
    // Credentials in the material go to the vault, never into the spec.
    let secretsStored = 0;
    const first = outcome.secrets[0];
    if (first && i.auth.type === "none") {
      const ref = this.vault.put(
        first.kind === "basic" ? first.value : first.value,
        id,
      );
      i.auth =
        first.kind === "bearer"
          ? { type: "bearer", ref }
          : first.kind === "basic"
            ? { type: "basic", ref }
            : first.kind === "query"
              ? { type: "query", name: first.name ?? "api_key", ref }
              : { type: "header", name: first.name ?? "X-API-Key", ref };
      secretsStored++;
    } else if (first) {
      notes.push(
        "Credentials found in the material were discarded; the existing credential of this integration was kept.",
      );
    }
    const firstTime =
      i.status === "needs_info" ||
      i.operations.every((o) =>
        o.hints.includes("no machine-readable description found"),
      );
    if (firstTime) {
      i.operations = i.operations.filter(
        (o) => !o.hints.includes("no machine-readable description found"),
      );
      if (outcome.protocol !== i.protocol && outcome.kind !== "curl")
        i.protocol = outcome.protocol;
    }
    const diff = this.merge(i, outcome.operations, {
      applyPending: true,
      authoritative: false,
    });
    i.source = `user-provided ${outcome.kind}`;
    i.specVersion++;
    i.learnedAt = new Date().toISOString();
    i.needs = [];
    if (outcome.auth && i.auth.type === "none")
      notes.push(
        `The material suggests authentication '${outcome.auth.type}'; pass a token to api_connect to set it.`,
      );
    i.notes = [...notes, ...i.notes].slice(0, 10);
    i.status = "ready";
    this.registry.save(i);
    const outcomeProbe = await this.runProbe(i, signal);
    i.lastTest = this.testRecord(outcomeProbe, i.probe);
    if (outcomeProbe?.authRejected) i.status = "credentials_expired";
    this.registry.save(i);
    return {
      ok: true as const,
      kind: outcome.kind,
      integration: i,
      ...diff,
      secretsStored,
      notes,
    };
  }

  remove(id: string): boolean {
    const i = this.registry.remove(id);
    if (!i) return false;
    if (i.auth.type !== "none") this.vault.delete(i.auth.ref);
    forgetTokens(id);
    return true;
  }

  /** api_configure: switch operations on/off, raise or (with confirmation, handled by the tool layer) lower their risk. */
  configure(
    id: string,
    operation: string,
    change: { enabled?: boolean; risk?: Risk; applyPending?: boolean },
  ) {
    const i = this.integration(id);
    const op = i.operations.find((o) => o.id === operation);
    if (!op) throw new AdapterError(`No operation '${operation}'.`);
    if (change.risk) {
      if (RISK_RANK[change.risk] < RISK_RANK[op.floor])
        throw new AdapterError(
          `The risk of '${operation}' cannot go below ${op.floor}: that is what the engine could prove.`,
        );
      op.risk = change.risk;
      op.routine = op.routine && change.risk === "READ_ONLY";
    }
    if (change.applyPending && op.pending) {
      const pending = op.pending;
      Object.assign(op, {
        ...pending,
        risk: maxRisk(op.risk, pending.floor),
        enabled: op.enabled,
        stats: op.stats,
      });
      delete op.pending;
    }
    if (change.enabled !== undefined) op.enabled = change.enabled;
    i.probe = this.pickProbe(i)?.id;
    this.registry.save(i);
    return op;
  }
}
