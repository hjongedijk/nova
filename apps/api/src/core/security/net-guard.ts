import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/*
 * Outbound access for tools that fetch what the model asks for. NOVA sits on a LAN with
 * Proxmox, Home Assistant and a message bus, so a model that can be talked into fetching
 * http://10.0.0.5 would be a way in. Everything here refuses non-public addresses, checked at
 * connect time, so a DNS answer cannot change between check and use.
 */

type LookupCallback = (
  error: Error | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

const toInt = (address: string) =>
  address.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>>
  0;

const BLOCKED_V4 = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
).map(([base, bits]) => {
  const start = toInt(base);
  return [start, start + 2 ** (32 - bits) - 1] as const;
});

function ipv6Integer(address: string): bigint | null {
  const lower = address.toLowerCase();
  const doubleColon = lower.indexOf("::");
  if (doubleColon !== lower.lastIndexOf("::")) return null;
  let expanded = lower;
  if (lower.includes(".")) {
    const lastColon = lower.lastIndexOf(":");
    const v4 = lower.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const n = toInt(v4);
    expanded = `${lower.slice(0, lastColon)}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = expanded.split("::");
  const left = parts[0] ? parts[0]!.split(":") : [];
  const right = parts[1] ? parts[1]!.split(":") : [];
  const zeroCount = 8 - left.length - right.length;
  if (
    (parts.length === 1 && zeroCount !== 0) ||
    zeroCount < (parts.length === 2 ? 1 : 0)
  )
    return null;
  const groups = [...left, ...Array(zeroCount).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  )
    return null;
  return groups.reduce(
    (value, part) => (value << 16n) | BigInt(`0x${part}`),
    0n,
  );
}

function inIpv6Range(address: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return address >> shift === base >> shift;
}

const V6 = (address: string) => ipv6Integer(address)!;
const V6_GLOBAL_UNICAST = [V6("2000::"), 3] as const;
const V6_IPV4_MAPPED = [V6("::ffff:0:0"), 96] as const;
const BLOCKED_V6 = [
  [V6("fc00::"), 7], // unique local
  [V6("fe80::"), 10], // link local
  [V6("ff00::"), 8], // multicast
  [V6("2001::"), 23], // IETF protocol assignments
  [V6("2001:db8::"), 32], // documentation
  [V6("2002::"), 16], // deprecated 6to4
] as const;

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = toInt(address);
    return BLOCKED_V4.some(([start, end]) => value >= start && value <= end);
  }
  if (family === 6) {
    const value = ipv6Integer(address);
    if (value === null || value === 0n || value === 1n) return true;
    if (inIpv6Range(value, ...V6_IPV4_MAPPED)) {
      const mapped = Number(value & 0xffff_ffffn);
      return isPrivateAddress(
        `${(mapped >>> 24) & 255}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`,
      );
    }
    if (!inIpv6Range(value, ...V6_GLOBAL_UNICAST)) return true;
    return BLOCKED_V6.some(([base, bits]) => inIpv6Range(value, base, bits));
  }
  return true; // not an IP: never trust it
}

/** A `lookup` for http(s).request that resolves normally, given a rule for which answers are allowed. */
export function lookupAllowing(
  blocked: (address: string) => boolean,
  message: string,
) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: LookupCallback,
  ) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = addresses.filter((item) => !blocked(item.address));
      if (!allowed.length || allowed.length !== addresses.length)
        return callback(new Error(message));
      if (options?.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

export const guardedLookup = lookupAllowing(
  isPrivateAddress,
  "Blocked: address is not public",
);

export function assertPublicUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password)
    throw new Error("URLs with credentials are not allowed");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!["80", "443"].includes(port))
    throw new Error("Only the standard web ports are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!host.includes(".") && !net.isIP(host))
  )
    throw new Error("Blocked: not a public host");
  if (net.isIP(host) && isPrivateAddress(host))
    throw new Error("Blocked: address is not public");
  return url;
}

export interface PublicResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}

export interface FetchPublicOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function once(
  target: string,
  options: Required<Omit<FetchPublicOptions, "signal" | "headers">> &
    FetchPublicOptions,
) {
  const url = assertPublicUrl(target);
  const client = url.protocol === "https:" ? https : http;
  return new Promise<PublicResponse>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        signal: options.signal,
        timeout: options.timeoutMs,
        headers: {
          accept: options.accept,
          "user-agent":
            "Mozilla/5.0 (compatible; NOVA/1.0; +private assistant)",
          "accept-language": "nl,en;q=0.8",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            request.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            url: url.toString(),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}

/** GET a public URL, following up to three redirects and checking every hop again. */
export async function fetchPublic(
  target: string,
  options: FetchPublicOptions = {},
): Promise<PublicResponse> {
  const settings = {
    accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9",
    maxBytes: 1_500_000,
    timeoutMs: 10_000,
    ...options,
  };
  let current = target;
  for (let hop = 0; hop <= 3; hop++) {
    const response = await once(current, settings);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects");
}
