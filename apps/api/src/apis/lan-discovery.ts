import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { isLanAddress } from "../core/security/net-guard.js";

/*
 * Read-only discovery of well-known services on the owner's own LAN. Only RFC 1918 addresses are
 * ever touched (checked per target through net-guard), nothing is sent but a TCP connect, one GET
 * of a landing page and a multicast "who is there" question, and credentials are never guessed.
 */

export type AuthNeed = "none" | "token" | "unknown";

export interface KnownService {
  id: string;
  name: string;
  port: number;
  tls: boolean;
  /** Landing page to fingerprint; null: an open TCP port is the whole signal (MQTT). */
  path: string | null;
  match: RegExp | null;
  auth: AuthNeed;
  /** Can the api_connect pipeline learn it (an HTTP API)? */
  apiConnect: boolean;
}

export const KNOWN_SERVICES: readonly KnownService[] = [
  {
    id: "home_assistant",
    name: "Home Assistant",
    port: 8123,
    tls: false,
    path: "/",
    match: /home assistant/i,
    auth: "token",
    apiConnect: false,
  },
  {
    id: "proxmox",
    name: "Proxmox",
    port: 8006,
    tls: true,
    path: "/",
    match: /proxmox/i,
    auth: "token",
    apiConnect: false,
  },
  {
    id: "node_red",
    name: "Node-RED",
    port: 1880,
    tls: false,
    path: "/",
    match: /node-red/i,
    auth: "unknown",
    apiConnect: true,
  },
  {
    id: "mqtt",
    name: "MQTT-broker",
    port: 1883,
    tls: false,
    path: null,
    match: null,
    auth: "unknown",
    apiConnect: false,
  },
  {
    id: "omniroute",
    name: "OmniRoute",
    port: 20128,
    tls: false,
    path: "/",
    match: /omniroute/i,
    auth: "token",
    apiConnect: false,
  },
  {
    id: "qdrant",
    name: "Qdrant",
    port: 6333,
    tls: false,
    path: "/",
    match: /qdrant/i,
    auth: "none",
    apiConnect: true,
  },
  {
    id: "grafana",
    name: "Grafana",
    port: 3000,
    tls: false,
    path: "/login",
    match: /grafana/i,
    auth: "token",
    apiConnect: false,
  },
];

export interface Candidate {
  id: string;
  service: string;
  name: string;
  host: string;
  port: number;
  url: string;
  auth: AuthNeed;
  apiConnect: boolean;
  firstSeen: number;
  lastSeen: number;
  /** new: not yet proposed; proposed: told to the owner; dismissed/connected: leave alone. */
  state: "new" | "proposed" | "dismissed" | "connected";
}

export interface HttpProbe {
  status: number;
  body: string;
}

/** What touches the network; replaced by a fake in tests. */
export interface DiscoveryTransport {
  /** IPv4 addresses with their prefix length. */
  interfaces(): { address: string; prefix: number }[];
  tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean>;
  httpGet(
    host: string,
    port: number,
    tls: boolean,
    path: string,
    timeoutMs: number,
  ): Promise<HttpProbe | null>;
  /** Hosts that answered an mDNS/SSDP question. */
  multicastHints(timeoutMs: number): Promise<string[]>;
}

export interface ScanLimits {
  maxHosts: number;
  concurrency: number;
  connectTimeoutMs: number;
  budgetMs: number;
  maxRequests: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxHosts: 254,
  concurrency: 32,
  connectTimeoutMs: 600,
  budgetMs: 30_000,
  maxRequests: 3000,
};

export interface ScanReport {
  found: Candidate[];
  hosts: number;
  requests: number;
  truncated: boolean;
}

/** The own /24 of every private interface address (never wider, never public), minus our own address. */
export function lanHosts(
  interfaces: { address: string; prefix: number }[],
  max: number,
): string[] {
  const hosts = new Set<string>();
  for (const { address } of interfaces) {
    if (!isLanAddress(address)) continue;
    const [a, b, c] = address.split(".");
    for (let d = 1; d <= 254; d++) {
      const host = `${a}.${b}.${c}.${d}`;
      if (host !== address) hosts.add(host);
    }
  }
  return [...hosts].slice(0, max);
}

const candidateId = (service: string, host: string, port: number) =>
  `${service}@${host}:${port}`;

export async function scanLan(
  transport: DiscoveryTransport,
  now: number,
  limits: ScanLimits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<ScanReport> {
  const deadline = Date.now() + limits.budgetMs;
  let requests = 0;
  let truncated = false;
  const spent = () => {
    if (
      signal?.aborted ||
      Date.now() > deadline ||
      requests >= limits.maxRequests
    ) {
      truncated = true;
      return true;
    }
    return false;
  };
  const hints = (
    await transport.multicastHints(1500).catch(() => [] as string[])
  ).filter(isLanAddress);
  const hosts = [
    ...new Set([
      ...hints,
      ...lanHosts(transport.interfaces(), limits.maxHosts),
    ]),
  ]
    .filter(isLanAddress)
    .slice(0, limits.maxHosts);
  const found = new Map<string, Candidate>();
  const jobs = hosts.flatMap((host) =>
    KNOWN_SERVICES.map((service) => ({ host, service })),
  );
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      if (spent()) return;
      const { host, service } = job;
      // Every single touch re-checks the range: a bug upstream must not become a public scan.
      if (!isLanAddress(host)) continue;
      requests++;
      if (
        !(await transport.tcpOpen(host, service.port, limits.connectTimeoutMs))
      )
        continue;
      if (service.path) {
        if (spent()) return;
        requests++;
        const page = await transport
          .httpGet(host, service.port, service.tls, service.path, 2500)
          .catch(() => null);
        if (!page || (service.match && !service.match.test(page.body)))
          continue;
      }
      const id = candidateId(service.id, host, service.port);
      found.set(id, {
        id,
        service: service.id,
        name: service.name,
        host,
        port: service.port,
        url: `${service.tls ? "https" : "http"}://${host}:${service.port}`,
        auth: service.auth,
        apiConnect: service.apiConnect,
        firstSeen: now,
        lastSeen: now,
        state: "new",
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limits.concurrency, jobs.length) }, worker),
  );
  return {
    found: [...found.values()],
    hosts: hosts.length,
    requests,
    truncated,
  };
}

/** The one-line proposal the owner reads. Credentials are never invented: a login-protected service asks for the owner's own token. */
export function proposalText(c: Candidate): { title: string; detail: string } {
  const title = `Ik vond ${c.name} op ${c.host}`;
  if (c.apiConnect && c.auth !== "token")
    return {
      title,
      detail: `Verbinden? Zeg 'ja, koppel ${c.name}' en ik leer de API van ${c.url} kennen (alleen lezen, zonder inloggegevens).`,
    };
  if (c.service === "mqtt")
    return {
      title,
      detail: `Er luistert een MQTT-broker op ${c.host}:${c.port}. Wil je dat ik die gebruik, vul dan het adres in bij de instellingen; inloggegevens verzin ik niet.`,
    };
  return {
    title,
    detail: `Verbinden? Daarvoor heb ik een toegangssleutel van jou nodig; die verzin ik niet. Geef 'm bij de instellingen van ${c.name}, of zeg 'verbind ${c.name}' en plak de sleutel.`,
  };
}

// ---- the real network ---------------------------------------------------------------------------

const MDNS_QUERY = Buffer.from(
  "000000000001000000000000" +
    "115f686f6d652d617373697374616e74045f746370056c6f63616c00" +
    "000c0001",
  "hex",
);
const SSDP_SEARCH = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n',
);

function netmaskPrefix(mask: string): number {
  return mask
    .split(".")
    .reduce(
      (n, part) => n + Number(part).toString(2).replace(/0/g, "").length,
      0,
    );
}

function listen(
  socket: dgram.Socket,
  timeoutMs: number,
  send: () => void,
): Promise<string[]> {
  return new Promise((resolve) => {
    const hosts = new Set<string>();
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...hosts]);
    };
    socket.on("message", (_message, remote) => hosts.add(remote.address));
    socket.on("error", done);
    setTimeout(done, timeoutMs).unref?.();
    try {
      send();
    } catch {
      done();
    }
  });
}

export const realTransport: DiscoveryTransport = {
  interfaces() {
    const out: { address: string; prefix: number }[] = [];
    for (const list of Object.values(os.networkInterfaces()))
      for (const item of list ?? [])
        if (item.family === "IPv4" && !item.internal)
          out.push({
            address: item.address,
            prefix: netmaskPrefix(item.netmask),
          });
    return out;
  },
  tcpOpen(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  },
  httpGet(host, port, tls, path, timeoutMs) {
    return new Promise((resolve) => {
      const request = (tls ? https : http).request(
        {
          host,
          port,
          path,
          method: "GET",
          timeout: timeoutMs,
          headers: { "user-agent": "NOVA-lan-discovery", accept: "text/html" },
          // A LAN appliance with a self-signed certificate: only fingerprinted, never trusted or sent a secret.
          ...(tls ? { rejectUnauthorized: false } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 64_000) chunks.push(chunk);
            else response.destroy();
          });
          const end = () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          response.on("end", end);
          response.on("close", end);
          response.on("error", () => resolve(null));
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => resolve(null));
      request.end();
    });
  },
  async multicastHints(timeoutMs) {
    const mdns = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const ssdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const results = await Promise.all([
      listen(mdns, timeoutMs, () => mdns.send(MDNS_QUERY, 5353, "224.0.0.251")),
      listen(ssdp, timeoutMs, () =>
        ssdp.send(SSDP_SEARCH, 1900, "239.255.255.250"),
      ),
    ]);
    return results.flat().filter(isLanAddress);
  },
};
