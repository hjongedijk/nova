import { Controller, Get, Header, Query } from "@nestjs/common";
import type { IncomingHttpHeaders } from "node:http";
import { fetchPublic } from "../core/security/net-guard.js";
import { safeHttpUrl } from "./window-media.js";

/**
 * Whether a page may be shown inside NOVA's result window (an iframe), from its own X-Frame-Options and CSP
 * frame-ancestors. Public addresses only (fetchPublic refuses LAN and loopback); answers only a boolean.
 */
export function frameableFrom(headers: IncomingHttpHeaders): boolean {
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value.join(",") : (value ?? "")).toLowerCase();
  const xfo = one(headers["x-frame-options"]);
  if (/deny|sameorigin|allow-from/.test(xfo)) return false;
  const csp = one(headers["content-security-policy"]);
  const ancestors = /frame-ancestors([^;]*)/.exec(csp)?.[1]?.trim();
  if (ancestors !== undefined) {
    const sources = ancestors.split(/\s+/).filter(Boolean);
    // NOVA's own origin is never on another site's list; only a wildcard lets it in.
    if (!sources.some((source) => source === "*" || source === "https:"))
      return false;
  }
  return true;
}

const cache = new Map<string, { at: number; value: boolean }>();
const TTL = 10 * 60_000;

@Controller("live")
export class LiveController {
  @Get("frameable")
  @Header("Cache-Control", "no-store")
  async frameable(@Query("url") raw?: string): Promise<{ frameable: boolean }> {
    const url = safeHttpUrl(raw);
    if (!url) return { frameable: false };
    const key = new URL(url).origin + new URL(url).pathname;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return { frameable: hit.value };
    let value: boolean;
    try {
      const response = await fetchPublic(url, {
        timeoutMs: 6000,
        maxBytes: 3_000_000,
      });
      value = response.status < 400 && frameableFrom(response.headers);
    } catch {
      value = false;
    }
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), value });
    return { frameable: value };
  }
}
