import type { Risk } from "@nova/contracts";

/**
 * Declarative integration specs. Everything NOVA learns about an API is data in these shapes; it is
 * interpreted by the built-in adapters (rest, graphql, soap, jsonrpc). No learned or downloaded code ever runs.
 */
export type ApiProtocol = "rest" | "graphql" | "soap" | "jsonrpc";

/** Credentials are never part of a scheme: `ref` points into the encrypted vault. */
export type AuthScheme =
  | { type: "none" }
  | { type: "bearer"; ref: string }
  | { type: "basic"; ref: string }
  | { type: "header"; name: string; ref: string; prefix?: string }
  | { type: "query"; name: string; ref: string }
  | {
      type: "oauth2_client_credentials";
      tokenUrl: string;
      ref: string;
      scope?: string;
    };

export interface ApiParam {
  /** Name the model uses. */
  name: string;
  /** Name on the wire when it differs from `name`. */
  wire?: string;
  in: "path" | "query" | "header" | "body" | "arg";
  required: boolean;
  schema: Record<string, unknown>;
  description?: string;
}

export type OperationStatus = "ok" | "degraded" | "deprecated" | "gone";

export interface ApiOperation {
  id: string;
  summary: string;
  /** rest: HTTP method. graphql: query|mutation. soap: POST. jsonrpc: POST. */
  method: string;
  /** rest: path template. graphql: root field. soap: operation name. jsonrpc: method name. */
  path: string;
  params: ApiParam[];
  body?: {
    contentType: string;
    schema: Record<string, unknown>;
    required: boolean;
  };
  /** Dotted path into the decoded response that holds the useful part. */
  responsePath?: string;
  risk: Risk;
  /** What the engine itself proved; the user can raise `risk` but never go below this. */
  floor: Risk;
  routine: boolean;
  enabled: boolean;
  status: OperationStatus;
  hints: string[];
  gql?: {
    kind: "query" | "mutation";
    args: { name: string; type: string }[];
    selection: string;
  };
  soap?: { action: string; namespace: string; element: string };
  /** A changed definition for a mutating operation, waiting for the user's approval. */
  pending?: Omit<ApiOperation, "pending">;
  hash: string;
  stats: {
    ok: number;
    fail: number;
    failStreak: number;
    lastStatus?: number;
    lastAt?: string;
  };
}

export type IntegrationStatus =
  "ready" | "needs_info" | "credentials_expired" | "degraded" | "unreachable";

export interface ApiIntegration {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  local: boolean;
  auth: AuthScheme;
  operations: ApiOperation[];
  specVersion: number;
  source: string;
  status: IntegrationStatus;
  createdAt: string;
  learnedAt: string;
  lastTest?: {
    at: string;
    ok: boolean;
    status?: number;
    operation?: string;
    note: string;
  };
  counters: { ok: number; fail: number };
  maintenance: {
    nextDueAt: number;
    nextDiscoveryAt: number;
    failStreak: number;
    authFailStreak: number;
  };
  notes: string[];
  needs: string[];
  deprecated?: boolean;
  /** Probe operation used by api_test and by maintenance. */
  probe?: string;
  /** Requests per minute. */
  rateLimit: number;
}

export const RISK_RANK: Record<Risk, number> = {
  READ_ONLY: 0,
  SAFE: 1,
  CONFIRM: 2,
  DANGEROUS: 3,
};
export const maxRisk = (a: Risk, b: Risk): Risk =>
  RISK_RANK[a] >= RISK_RANK[b] ? a : b;

export interface ProbeLog {
  probe: string;
  url: string;
  status?: number;
  outcome: string;
}

export type AuthHint =
  | { type: "none" | "unknown"; note?: string }
  | { type: "bearer" | "basic"; note?: string }
  | { type: "header" | "query"; name: string; note?: string }
  | {
      type: "oauth2_client_credentials";
      tokenUrl: string;
      scope?: string;
      note?: string;
    };

export interface DiscoveryReport {
  ok: boolean;
  protocol?: ApiProtocol;
  /** Endpoint the adapters must call (may differ from the URL the user gave, same host only). */
  baseUrl?: string;
  title?: string;
  source?: string;
  operations: ApiOperation[];
  auth?: AuthHint;
  tried: ProbeLog[];
  needs: string[];
  notes: string[];
}
