import type {
  PublicResponse,
  FetchPublicOptions,
} from "../../core/security/net-guard.js";
import type { HomeLocation } from "./home.js";

/** How the world tools reach the network. Replaceable, so tests never leave the machine. */
export interface WorldHttp {
  /** Fixed, trusted API endpoints (Open-Meteo, Frankfurter, ...). */
  getJson<T = unknown>(url: string, signal?: AbortSignal): Promise<T>;
  /** Anything the model can ask for: must refuse non-public addresses. */
  getPage(url: string, options?: FetchPublicOptions): Promise<PublicResponse>;
  /**
   * JSON from one of NOVA's own stack services (SearXNG). Only URLs under `allowedBase`, which comes from
   * the operator's configuration, never from the model. Optional so test doubles can leave it out.
   */
  getServiceJson?<T = unknown>(
    url: string,
    options: ServiceJsonOptions,
  ): Promise<T>;
}

export interface ServiceJsonOptions {
  /** The configured service base URL; the request must stay on its origin and path. */
  allowedBase: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Where Home Assistant's zone.home comes from. The Home Assistant module registers one with
 * WorldService.useHomeSource(); without it the configured coordinates and the cache are used.
 */
export interface HomeSource {
  /** Wait for Home Assistant to have synced; failures are ignored. */
  sync?(): Promise<void>;
  /** The zone.home coordinates, or null while unknown. */
  zoneHome(): HomeLocation | null;
}

export const WORLD_HTTP = Symbol("nova:world-http");

/** Kept for readers of this folder: what a tool call hands back. */
export type { HomeLocation };
