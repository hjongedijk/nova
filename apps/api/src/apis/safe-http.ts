import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { isPrivateAddress } from "../core/security/net-guard.js";

export type BlockCode =
  | "blocked_address"
  | "blocked_scheme"
  | "blocked_host"
  | "redirect_blocked"
  | "credentials_origin"
  | "content_type"
  | "timeout"
  | "rate_limited"
  | "network";

export class ApiHttpError extends Error {
  constructor(
    readonly code: BlockCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

const NOVA_INTERNAL_HOSTS = new Set([
  "localhost",
  "nova",
  "jarvis-api",
  "jarvis-web",
  "jarvis-tts",
  "jarvis-node-red",
  "jarvis-omniroute",
  "node-red",
  "mqtt",
  "omniroute",
  "qdrant",
  "stack-control",
]);

const toInt = (address: string) =>
  address.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>>
  0;

function ipv4Of(address: string): number | null {
  if (net.isIP(address) === 4) return toInt(address);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ? toInt(mapped[1]) : null;
}

/** Never reachable, not even for an integration the user marked as local network. */
export function isMetadataOrUnroutable(address: string): boolean {
  const v4 = ipv4Of(address);
  if (v4 !== null) {
    const first = v4 >>> 24;
    return (
      first === 0 ||
      v4 >>> 16 === 0xa9fe || // 169.254.0.0/16 link-local + cloud metadata
      v4 === toInt("100.100.100.200") || // Alibaba metadata
      first >= 224 // multicast, reserved, broadcast
    );
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::" ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff") ||
      lower === "fd00:ec2::254"
    );
  }
  return true;
}

export function isLoopback(address: string): boolean {
  const v4 = ipv4Of(address);
  if (v4 !== null) return v4 >>> 24 === 127;
  return address === "::1";
}

/** May a connection to this resolved address be made? */
export function addressAllowed(address: string, local: boolean): boolean {
  if (isMetadataOrUnroutable(address)) return false;
  return local || !isPrivateAddress(address);
}

export type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolver: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map(
    (item) => item.address,
  );

export interface ApiHttpRequest {
  url: string;
  method: string;
  integrationId: string;
  /** Not secret: content type, accept, SOAPAction, ... */
  headers?: Record<string, string>;
  body?: string;
  /** Secret material; only ever sent to `url` itself or to a same-origin redirect. */
  credentials?: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
  local: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  rateLimit?: number;
  signal?: AbortSignal;
}

export interface ApiHttpResponse {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  truncated: boolean;
  /** The URL as called, without credential query parameters. */
  url: string;
  pinnedIp: string;
  /** A same-host redirect that was followed (hint for self-healing a moved path). */
  redirectedTo?: string;
}

const EXPOSED_HEADERS = [
  "content-type",
  "www-authenticate",
  "location",
  "retry-after",
  "deprecation",
  "sunset",
  "link",
  "x-ratelimit-remaining",
];
const ALLOWED_TYPE =
  /^(?:application\/(?:[\w.+-]*json|[\w.+-]*xml|graphql[\w+-]*|x-www-form-urlencoded|x-ndjson|jsonl|yaml|x-yaml|problem\+json)|text\/[\w.+-]+|)$/i;

export const MAX_RESPONSE_BYTES = 1_000_000;
export const TRUNCATION_MARKER =
  "\n[... truncated by NOVA: response larger than 1 MB]";

/**
 * The only way the engine talks to the network. Resolves DNS itself, checks every answer, pins the first
 * allowed address for the connection (so the answer cannot change between check and use), does not follow
 * redirects to other hosts, caps time and size, and never sends credentials anywhere but the integration's own origin.
 */
export class ApiHttpClient {
  private readonly windows = new Map<string, number[]>();
  private readonly active = new Map<string, number>();

  constructor(
    private readonly options: {
      resolve?: Resolver;
      ownPort?: number;
      maxConcurrent?: number;
    } = {},
  ) {}

  private admit(id: string, perMinute: number): void {
    const now = Date.now();
    const window = (this.windows.get(id) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (window.length >= perMinute)
      throw new ApiHttpError(
        "rate_limited",
        `Rate limit of ${perMinute} requests per minute reached for this integration; try again in a minute.`,
      );
    if ((this.active.get(id) ?? 0) >= (this.options.maxConcurrent ?? 4))
      throw new ApiHttpError(
        "rate_limited",
        "Too many simultaneous requests to this integration.",
      );
    window.push(now);
    this.windows.set(id, window);
  }

  async request(req: ApiHttpRequest): Promise<ApiHttpResponse> {
    this.admit(req.integrationId, req.rateLimit ?? 60);
    this.active.set(
      req.integrationId,
      (this.active.get(req.integrationId) ?? 0) + 1,
    );
    try {
      return await this.follow(req);
    } finally {
      this.active.set(
        req.integrationId,
        Math.max(0, (this.active.get(req.integrationId) ?? 1) - 1),
      );
    }
  }

  private async follow(req: ApiHttpRequest): Promise<ApiHttpResponse> {
    let current = new URL(req.url);
    const origin = current.origin;
    const method = req.method.toUpperCase();
    let redirectedTo: string | undefined;
    for (let hop = 0; hop <= 3; hop++) {
      const response = await this.once(current, method, req, origin);
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        const next = new URL(location, current);
        if (next.origin !== origin)
          throw new ApiHttpError(
            "redirect_blocked",
            `The server redirected to another host (${next.host}); NOVA does not follow redirects to other hosts or send credentials there.`,
          );
        if (method !== "GET" && method !== "HEAD")
          return { ...response, redirectedTo: next.pathname };
        current = next;
        redirectedTo = next.pathname;
        continue;
      }
      return { ...response, ...(redirectedTo ? { redirectedTo } : {}) };
    }
    throw new ApiHttpError("redirect_blocked", "Too many redirects.");
  }

  private async resolveAndPin(url: URL, local: boolean): Promise<string> {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      throw new ApiHttpError(
        "blocked_scheme",
        url.protocol === "http:"
          ? "Plain http is only allowed for integrations explicitly marked as local network; use https."
          : "Only https (or http for local network) is supported.",
      );
    if (url.username || url.password)
      throw new ApiHttpError(
        "blocked_scheme",
        "Put credentials in the vault, not in the URL.",
      );
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (NOVA_INTERNAL_HOSTS.has(host) || host.endsWith(".localhost"))
      throw new ApiHttpError(
        "blocked_host",
        "This address belongs to NOVA itself or its internal services and is blocked.",
      );
    const addresses = net.isIP(host)
      ? [host]
      : await (this.options.resolve ?? defaultResolver)(host);
    if (!addresses.length)
      throw new ApiHttpError("network", "The host name did not resolve.");
    const bad = addresses.find((address) => !addressAllowed(address, local));
    if (bad)
      throw new ApiHttpError(
        "blocked_address",
        isMetadataOrUnroutable(bad)
          ? "Blocked: the address is a link-local, cloud-metadata or otherwise unroutable address (never allowed)."
          : "Blocked: the address is on a private or local network. Mark the integration as 'local network' if this is intended.",
      );
    const pinned = addresses[0]!;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (isLoopback(pinned) && port === (this.options.ownPort ?? 3000))
      throw new ApiHttpError(
        "blocked_host",
        "This is NOVA's own port and is blocked.",
      );
    return pinned;
  }

  private async once(
    url: URL,
    method: string,
    req: ApiHttpRequest,
    origin: string,
  ): Promise<ApiHttpResponse> {
    if (url.origin !== origin)
      throw new ApiHttpError(
        "credentials_origin",
        "Credentials are never sent to another origin.",
      );
    const pinned = await this.resolveAndPin(url, req.local);
    const target = new URL(url);
    const secretQuery = new Set(Object.keys(req.credentials?.query ?? {}));
    for (const [key, value] of Object.entries(req.credentials?.query ?? {}))
      target.searchParams.set(key, value);
    const display = new URL(url);
    for (const key of secretQuery) display.searchParams.delete(key);
    const maxBytes = Math.min(
      req.maxBytes ?? MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    const client = url.protocol === "https:" ? https : http;
    const hostHeader = url.host;
    return new Promise<ApiHttpResponse>((resolve, reject) => {
      const headers: Record<string, string> = {
        accept: "application/json, application/xml;q=0.9, text/*;q=0.5",
        "user-agent": "NOVA-API-Engine/1",
        "accept-encoding": "identity",
        ...(req.headers ?? {}),
        ...(req.credentials?.headers ?? {}),
        host: hostHeader,
      };
      if (req.body !== undefined && method !== "GET" && method !== "HEAD")
        headers["content-length"] = String(Buffer.byteLength(req.body));
      const request = client.request(
        {
          host: pinned,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          servername: net.isIP(url.hostname) ? undefined : url.hostname,
          signal: req.signal,
          timeout: req.timeoutMs ?? 15_000,
        } as https.RequestOptions,
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          response.on("data", (chunk: Buffer) => {
            if (truncated) return;
            size += chunk.length;
            if (size > maxBytes) {
              chunks.push(
                chunk.subarray(
                  0,
                  Math.max(0, chunk.length - (size - maxBytes)),
                ),
              );
              truncated = true;
              request.destroy();
              finish();
              return;
            }
            chunks.push(chunk);
          });
          const finish = () => {
            const type = String(response.headers["content-type"] ?? "")
              .split(";")[0]!
              .trim();
            const status = response.statusCode ?? 0;
            const exposed: Record<string, string> = {};
            for (const name of EXPOSED_HEADERS) {
              const value = response.headers[name];
              if (typeof value === "string")
                exposed[name] = value.slice(0, 500);
            }
            if (status >= 200 && status < 300 && !ALLOWED_TYPE.test(type)) {
              reject(
                new ApiHttpError(
                  "content_type",
                  `Response content type '${type.slice(0, 60)}' is not supported (only JSON, XML and text).`,
                ),
              );
              return;
            }
            let raw = Buffer.concat(chunks);
            try {
              const encoding = String(
                response.headers["content-encoding"] ?? "",
              );
              if (/gzip/i.test(encoding))
                raw = zlib.gunzipSync(raw, { maxOutputLength: maxBytes });
              else if (/deflate/i.test(encoding))
                raw = zlib.inflateSync(raw, { maxOutputLength: maxBytes });
            } catch {
              truncated = true;
            }
            resolve({
              status,
              headers: exposed,
              contentType: type,
              body: raw.toString("utf8") + (truncated ? TRUNCATION_MARKER : ""),
              truncated,
              url: display.toString(),
              pinnedIp: pinned,
            });
          };
          response.on("end", () => {
            if (!truncated) finish();
          });
          response.on("error", (error) => {
            if (!truncated) reject(new ApiHttpError("network", error.message));
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(
          new ApiHttpError("timeout", "The API did not answer in time."),
        ),
      );
      request.on("error", (error) => {
        reject(
          error instanceof ApiHttpError
            ? error
            : new ApiHttpError(
                "network",
                `Network error: ${(error as NodeJS.ErrnoException).code ?? "failed"}`,
              ),
        );
      });
      if (req.body !== undefined && method !== "GET" && method !== "HEAD")
        request.write(req.body);
      request.end();
    });
  }
}
