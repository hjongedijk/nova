import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { ServiceCheckResult } from "@nova/contracts";

type Probe = Omit<ServiceCheckResult, "name">;

/** The services to watch: JARVIS_CHECK_TARGETS ("name=url,...") or NOVA's own stack. */
export function parseTargets(
  raw: string,
  proxmoxUrl = "",
): Record<string, string> {
  const targets: Record<string, string> = {};
  if (raw) {
    for (const part of raw.split(",")) {
      const [name, ...rest] = part.split("=");
      const url = rest.join("=").trim();
      if (
        name &&
        /^[a-z0-9-]{1,40}$/i.test(name.trim()) &&
        /^(https?|tcp):\/\//.test(url)
      )
        targets[name.trim().toLowerCase()] = url;
    }
    return targets;
  }
  Object.assign(targets, {
    "jarvis-api": "http://jarvis-api:3000/health",
    omniroute: "http://omniroute:20128/",
    mqtt: "tcp://mqtt:1883",
    spraak: "http://jarvis-tts:8000/health",
    qdrant: "http://qdrant:6333/",
    "home-assistant": "http://host.docker.internal:8123/",
  });
  if (proxmoxUrl) targets.proxmox = proxmoxUrl;
  return targets;
}

/** Is it reachable? TCP targets connect; HTTP ones count as up below status 500. */
export function probe(url: string, timeoutMs = 4000): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (ok: boolean, detail: string) =>
      resolve({ ok, ms: Date.now() - started, detail });
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return done(false, "ongeldige url");
    }
    if (target.protocol === "tcp:") {
      const socket = net.connect({
        host: target.hostname,
        port: Number(target.port),
        timeout: timeoutMs,
      });
      socket.on("connect", () => {
        socket.destroy();
        done(true, "poort open");
      });
      socket.on("timeout", () => {
        socket.destroy();
        done(false, "time-out");
      });
      socket.on("error", () => done(false, "geen verbinding"));
      return;
    }
    const client = target.protocol === "https:" ? https : http;
    // Reachability only: a LAN service with a self-signed certificate still counts as up.
    const request = client.request(
      target,
      { method: "GET", timeout: timeoutMs, rejectUnauthorized: false },
      (response) => {
        response.resume();
        done((response.statusCode ?? 0) < 500, `HTTP ${response.statusCode}`);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      done(false, "time-out");
    });
    request.on("error", () => done(false, "geen verbinding"));
    request.end();
  });
}
