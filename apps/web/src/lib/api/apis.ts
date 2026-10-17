import { getJson, sendJson } from "./client.ts";

export interface ApiIntegrationView {
  id: string;
  name: string;
  protocol: "rest" | "graphql" | "soap" | "jsonrpc";
  baseUrl: string;
  local: boolean;
  status:
    "ready" | "needs_info" | "credentials_expired" | "degraded" | "unreachable";
  auth: { type: string; name?: string; credentialStored: boolean | null };
  operations: number;
  enabledOperations: number;
  byRisk: Record<"READ_ONLY" | "SAFE" | "CONFIRM" | "DANGEROUS", number>;
  degradedOperations: string[];
  specSource: string;
  lastTest: {
    at: string;
    ok: boolean;
    status?: number;
    operation?: string;
    note: string;
  } | null;
  notes: string[];
  needs: string[];
  nextCheckAt: string;
}

export interface ApiConnectInput {
  baseUrl: string;
  name?: string;
  token?: string;
  localNetwork?: boolean;
  docsUrl?: string;
}

const STATUS: Record<
  ApiIntegrationView["status"],
  { tone: "ok" | "warn" | "bad" | "neutral"; label: string }
> = {
  ready: { tone: "ok", label: "werkt" },
  needs_info: { tone: "warn", label: "heeft meer info nodig" },
  credentials_expired: { tone: "bad", label: "token geweigerd" },
  degraded: { tone: "warn", label: "haperende acties" },
  unreachable: { tone: "bad", label: "onbereikbaar" },
};

export const apiStatus = (view: Pick<ApiIntegrationView, "status">) =>
  STATUS[view.status] ?? { tone: "neutral" as const, label: view.status };

const PROTOCOL: Record<ApiIntegrationView["protocol"], string> = {
  rest: "REST",
  graphql: "GraphQL",
  soap: "SOAP",
  jsonrpc: "JSON-RPC",
};
export const protocolLabel = (protocol: ApiIntegrationView["protocol"]) =>
  PROTOCOL[protocol] ?? protocol;

/** A form value that can be sent: an address with a scheme. */
export const validApiAddress = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

export const getApis = () =>
  getJson<{ integrations: ApiIntegrationView[] }>("/apis");
export const connectApi = (input: ApiConnectInput) =>
  sendJson<ApiIntegrationView & { loginVerified: boolean | null }>(
    "POST",
    "/apis",
    input,
  );
export const testApi = (id: string) =>
  sendJson<ApiIntegrationView>("POST", `/apis/${encodeURIComponent(id)}/test`);
export const removeApi = (id: string) =>
  sendJson<{ removed: boolean }>("DELETE", `/apis/${encodeURIComponent(id)}`);
