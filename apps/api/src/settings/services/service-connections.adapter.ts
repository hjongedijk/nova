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
