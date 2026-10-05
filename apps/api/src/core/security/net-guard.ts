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
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
).map(([base, bits]) => {
  const start = toInt(base);
  return [start, start + 2 ** (32 - bits) - 1] as const;
});

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = toInt(address);
    return BLOCKED_V4.some(([start, end]) => value >= start && value <= end);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    if (lower.startsWith("ff")) return true; // multicast
    return false;
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
