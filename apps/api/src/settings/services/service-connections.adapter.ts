import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import mqtt from "mqtt";
import type { ServiceConnectionTest } from "@nova/contracts";
import { NovaConfig } from "../../core/config/nova-config.js";
import { requestJson } from "../../core/http/http-json.js";
import {
  connectionSpec,
  type ConnectionValues,
} from "../../core/config/service-connections.js";

/** Connection checks never invoke a model, publish MQTT data or execute service actions. */
@Injectable()
export class ServiceConnectionsAdapter {
  constructor(private readonly config: NovaConfig) {}
  private readonly last = new Map<string, ServiceConnectionTest>();
  status(id: string): ServiceConnectionTest | null {
    connectionSpec(id);
    return this.last.get(id) ?? null;
  }

  async qdrantOverview(values: ConnectionValues) {
    const base = String(values.url ?? "").replace(/\/$/, "");
    if (!base)
      return {
        ok: false as const,
        message: "Vul eerst het Qdrant-adres in.",
        collections: [],
        truncated: false,
      };
    const headers: Record<string, string> = values.apiKey
      ? { "api-key": String(values.apiKey) }
      : {};
    try {
      const list = await requestJson<{
        result?: { collections?: unknown };
      }>(`${base}/collections`, {
        headers,
        timeoutMs: 5000,
        signal: AbortSignal.timeout(6000),
      });
      if (list.status < 200 || list.status >= 300)
        return {
          ok: false as const,
          message: "Qdrant weigerde het collectieoverzicht.",
          collections: [],
          truncated: false,
        };
      const raw = list.data?.result?.collections;
      if (!Array.isArray(raw))
        return {
          ok: false as const,
          message: "Qdrant gaf een ongeldig collectieoverzicht.",
          collections: [],
          truncated: false,
        };
      const names = raw.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const name = (entry as { name?: unknown }).name;
        return typeof name === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(name)
          ? [name]
          : [];
      });
      const selected = names.slice(0, 20);
      const collections = await Promise.all(
        selected.map(async (name) => {
          try {
            const response = await requestJson<{
              result?: {
                points_count?: unknown;
                indexed_vectors_count?: unknown;
                segments_count?: unknown;
                status?: unknown;
              };
            }>(`${base}/collections/${encodeURIComponent(name)}`, {
              headers,
              timeoutMs: 5000,
              signal: AbortSignal.timeout(6000),
            });
            const result = response.data?.result;
            const count = (value: unknown) =>
              typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0
                ? value
                : null;
            return {
              name,
              points:
                response.status >= 200 && response.status < 300
                  ? count(result?.points_count)
                  : null,
              indexedVectors:
                response.status >= 200 && response.status < 300
                  ? count(result?.indexed_vectors_count)
                  : null,
              segments:
                response.status >= 200 && response.status < 300
                  ? count(result?.segments_count)
                  : null,
              status:
                response.status >= 200 &&
                response.status < 300 &&
                ["green", "yellow", "red", "grey"].includes(
                  String(result?.status),
                )
                  ? String(result?.status)
                  : "unknown",
            };
          } catch {
            return {
              name,
              points: null,
              indexedVectors: null,
              segments: null,
              status: "unknown",
            };
          }
        }),
      );
      return {
        ok: true as const,
        message: "Alleen collectiegegevens gelezen; er is niets gewijzigd.",
        collections,
        truncated:
          names.length > selected.length || names.length !== raw.length,
      };
    } catch {
      return {
        ok: false as const,
        message: "Qdrant reageert niet binnen zes seconden.",
        collections: [],
        truncated: false,
      };
    }
  }

  async test(
    id: string,
    values: ConnectionValues,
  ): Promise<ServiceConnectionTest> {
    connectionSpec(id);
    const checkedAt = new Date().toISOString();
    const finish = (result: Omit<ServiceConnectionTest, "checkedAt">) => {
      const report = { ...result, checkedAt };
      this.last.set(id, report);
      return report;
    };
    const base = String(values.url ?? "").replace(/\/$/, "");
    if (id === "omniroute" && base !== this.config.verifiedOmniUrl)
      return finish({
        ok: false,
        message:
          "Dit adres is niet gekoppeld aan de lokaal geverifieerde gateway. Er is geen sleutel verstuurd.",
      });
    if (!base) return finish({ ok: false, message: "Vul eerst het adres in." });
    try {
      if (id === "mqtt") {
        const connected = await new Promise<boolean>((resolve) => {
          const client = mqtt.connect(base, {
            clientId: `nova-check-${crypto.randomUUID()}`,
            username: String(values.username || "") || undefined,
            password: String(values.password || "") || undefined,
            reconnectPeriod: 0,
            connectTimeout: 5000,
            clean: true,
          });
          let done = false;
          const stop = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            client.end(true);
            resolve(ok);
          };
          const timer = setTimeout(() => stop(false), 6000);
          client.once("connect", () => stop(true));
          client.once("error", () => stop(false));
          client.once("close", () => stop(false));
        });
        return finish({
          ok: connected,
          message: connected
            ? "De broker accepteert de verbinding. Er is niets gepubliceerd."
            : "De broker is niet bereikbaar of weigert de aanmelding.",
        });
      }
      const headers: Record<string, string> = {};
      let endpoint = "";
      if (id === "omniroute") {
        endpoint = "/models";
        if (values.apiKey) headers.authorization = `Bearer ${values.apiKey}`;
      } else if (id === "home-assistant") {
        endpoint = "/api/";
        if (values.token) headers.authorization = `Bearer ${values.token}`;
      } else if (id === "qdrant") {
        endpoint = "/collections";
        if (values.apiKey) headers["api-key"] = String(values.apiKey);
      } else if (id === "proxmox") {
        endpoint = "/api2/json/version";
        if (values.tokenId && values.tokenSecret)
          headers.authorization = `PVEAPIToken=${values.tokenId}=${values.tokenSecret}`;
      } else if (id === "termix") {
        endpoint = "/users/me";
        if (values.apiKey) headers.authorization = `Bearer ${values.apiKey}`;
      } else if (id === "pangolin") {
        endpoint = "/orgs";
        if (values.apiKey) headers.authorization = `Bearer ${values.apiKey}`;
      } else if (id === "windows") {
        endpoint = "/v1/status";
        if (values.token) headers.authorization = `Bearer ${values.token}`;
      } else if (id === "node-red") endpoint = "/settings";
      const response = await requestJson(base + endpoint, {
        headers,
        timeoutMs: 5000,
        signal: AbortSignal.timeout(6000),
        insecureTls:
          id === "proxmox"
            ? values.verifyTls === false
            : id === "pangolin" && values.insecureTls === true,
        ...(id === "pangolin" && values.host
          ? { hostHeader: String(values.host) }
          : {}),
      });
      const ok = response.status >= 200 && response.status < 300;
      const message = ok
        ? id === "omniroute"
          ? "De gateway antwoordt. Het gratis-route-beleid wordt afzonderlijk gecontroleerd."
          : "De koppeling antwoordt. Er is geen wijziging uitgevoerd."
        : response.status === 401 || response.status === 403
          ? "Toegang geweigerd. Controleer de sleutel en rechten."
          : response.status >= 300 && response.status < 400
            ? "Het adres verwijst door. Vul het uiteindelijke service-adres in."
            : `De service geeft fout ${response.status}. Controleer het adres en de servicestatus.`;
      return finish({ ok, message, status: response.status });
    } catch {
      return finish({
        ok: false,
        message:
          "Geen verbinding binnen zes seconden. Controleer adres, netwerk en certificaat.",
      });
    }
  }
}
