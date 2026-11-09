import type { NextFunction, Request, Response } from "express";
import net from "node:net";
import os from "node:os";

/**
 * Cross-site request and DNS-rebinding guard for /api. NOVA has no login, so a request from the owner's
 * own browser is trusted; what this stops is another website making that browser send one.
 *
 * - Host: an IP literal, a single-label or local name (nova, localhost, *.local, *.lan, *.internal,
 *   *.home.arpa), this machine's hostname, the NOVA_PUBLIC_URL host, or a NOVA_ALLOWED_HOSTS entry.
 *   Anything else is a rebound public name and is refused, also for reads.
 * - State-changing requests (not GET/HEAD/OPTIONS): a browser Origin must be this same origin, the
 *   NOVA_PUBLIC_URL host or an allowed host; without Origin, Sec-Fetch-Site must be same-origin or none.
 *   Clients that send neither (Node-RED, the chat bridge, curl) are not browsers and pass.
 * - A body must be JSON (a CORS-preflighted type NOVA never grants), or carry `x-nova-admin: 1`.
 *   Token-authenticated server routes that post forms are listed in FORM_ROUTES.
 */
export interface RequestGuardOptions {
  /** NOVA_PUBLIC_URL; only its host is used. */
  publicUrl?: string;
  /** NOVA_ALLOWED_HOSTS: exact names, `*.example.com` / `.example.com` suffixes, or `*` for any host. */
  allowedHosts?: string[];
  /** This machine's names; defaults to os.hostname(). */
  hostnames?: string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".internal",
  ".home.arpa",
  ".localdomain",
];
/** Server-to-server routes with their own shared token that legitimately post urlencoded forms. */
const FORM_ROUTES = [
  /^\/api\/integrations\/asterisk\/message\/?(?:\?|$)/,
  // The Node-RED editor (proxied, same origin) posts its own forms and checks Origin itself.
  /^\/api\/node-red-editor(?:\/|\?|$)/,
];

/** Host header value or URL host to a bare lower-case name: no port, brackets or trailing dot. */
export function bareHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else if (host.split(":").length === 2) host = host.split(":")[0]!;
  return host.replace(/\.+$/, "");
}

function publicHost(publicUrl?: string): string | null {
  if (!publicUrl) return null;
  try {
    return bareHost(new URL(publicUrl).host);
  } catch {
    return null;
  }
}

function listed(host: string, entries: string[]): boolean {
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/\.+$/, "");
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry.startsWith("*.") || entry.startsWith("."))
      return host.endsWith(entry.slice(entry.indexOf(".")));
    return host === bareHost(entry);
  });
}

export function hostAllowed(
  hostHeader: string | undefined,
  options: RequestGuardOptions,
): boolean {
  if (!hostHeader) return true; // HTTP/1.0 or a raw client: never a browser on a rebound name
  const host = bareHost(hostHeader);
  if (!host) return false;
  if (net.isIP(host)) return true;
  if (!host.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === publicHost(options.publicUrl)) return true;
  const own = (options.hostnames ?? [os.hostname()]).map((name) =>
    bareHost(name),
  );
  if (own.includes(host)) return true;
  return listed(host, options.allowedHosts ?? []);
}

export function originAllowed(
  origin: string,
  hostHeader: string | undefined,
  options: RequestGuardOptions,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (hostHeader && parsed.host.toLowerCase() === hostHeader.toLowerCase())
    return true;
  const host = bareHost(parsed.host);
  if (host === publicHost(options.publicUrl)) return true;
  return listed(
    host,
    (options.allowedHosts ?? []).filter((entry) => entry.trim() !== "*"),
  );
}

function isJson(contentType: string | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return (
    type === "application/json" || /^application\/[\w.-]+\+json$/.test(type)
  );
}

/** Why a request is refused, or null when it may pass. */
export function refusal(
  request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  },
  options: RequestGuardOptions,
): string | null {
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const host = header("host");
  if (!hostAllowed(host, options)) return "unknown host";
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = header("origin");
  const site = header("sec-fetch-site")?.toLowerCase();
  if (origin !== undefined) {
    if (!originAllowed(origin, host, options)) return "cross-site request";
  } else if (site !== undefined && site !== "same-origin" && site !== "none")
    return "cross-site request";
  if (FORM_ROUTES.some((route) => route.test(request.url))) return null;
  const type = header("content-type");
  if (type !== undefined && !isJson(type) && header("x-nova-admin") !== "1")
    return "unsupported content type";
  return null;
}

export function requestGuard(options: RequestGuardOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    const reason = refusal(
      {
        method: request.method,
        url: request.originalUrl,
        headers: request.headers,
      },
      options,
    );
    if (!reason) return next();
    response
      .status(reason === "unsupported content type" ? 415 : 403)
      .json({ error: `NOVA refused this request: ${reason}.` });
  };
}
