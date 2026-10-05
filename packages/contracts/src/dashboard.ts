import type {
  AlertInfo,
  ListsOverview,
  ProxmoxGuestInfo,
  ProxmoxStorageInfo,
  TimerInfo,
} from "./infrastructure.js";
import type { HomeSummary } from "./home.js";
import type { IssPosition, MarketRates, MoonPhase } from "./world.js";

/** GET /api/system: this machine, sampled on the server so a freshly opened page already has graphs. */
export interface HostSample {
  at: string;
  /** CPU use in percent. */
  cpu: number;
  cores: number;
  /** Load averages over 1, 5 and 15 minutes. */
  load: number[];
  memory: { total: number; used: number };
  disk: { total: number; used: number } | null;
  uptime: number;
}

export interface NetworkRate {
  rxPerSec: number;
  txPerSec: number;
}

export interface HostHistory {
  cpu: number[];
  memory: number[];
  rx: number[];
  tx: number[];
}

export interface SystemResponse extends HostSample {
  /** Null when no node-exporter is reachable. */
  network: NetworkRate | null;
  history: HostHistory;
}

/** Something NOVA says unasked: a watchdog alert or a timer that went off. */
export interface FeedEvent {
  seq: number;
  kind: "alert" | "timer";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  label?: string;
  key?: string;
  at: string;
}

/** GET /api/alerts?since=N */
export interface AlertsResponse {
  latest: number;
  events: FeedEvent[];
}

export interface WeatherNow {
  name?: string;
  condition?: string;
  temperature?: number | null;
  temperatureUnit?: string;
  humidity?: number | null;
  windSpeed?: number | null;
  windUnit?: string;
  pressure?: number | null;
  forecast: {
    place: string;
    hours: {
      time: string;
      temperature: number;
      rainChancePercent: number | null;
    }[];
  } | null;
}

export interface SunNow {
  aboveHorizon: boolean;
  elevation: number | null;
  azimuth: number | null;
  nextRising: string | null;
  nextSetting: string | null;
}

export interface AirNow {
  aqi: { value: number | null; label: string | null };
  uv: { value: number | null; label: string | null };
  pm25: number | null;
  pollen: { name: string; perM3: number; label: string | null } | null;
  summary: string;
}

/** GET /api/overview: everything the side panels show, one cached answer shared by all viewers. */
export interface OverviewResponse {
  at: string;
  proxmox: { guests: ProxmoxGuestInfo[]; storage: ProxmoxStorageInfo[] } | null;
  weather: WeatherNow | null;
  sun: SunNow | null;
  news: { title: string; link: string; published: string }[] | null;
  timers: TimerInfo[] | null;
  lists: ListsOverview | null;
  alerts: AlertInfo[] | null;
  home: HomeSummary | null;
  air: AirNow | null;
  markets: MarketRates | null;
  iss: IssPosition | null;
  moon: MoonPhase;
}

/** One service in GET /api/health that the dashboard cares about. */
export interface DashboardServiceHealth {
  online?: boolean;
  configured?: boolean;
}

/** The part of a Proxmox/other state entry that GET /api/health lists under `state`. */
export interface DashboardStateEntry {
  online?: boolean;
  connected?: boolean;
  stale?: boolean;
}

/** GET /api/health as the dashboard (Systeem panel, menu status, routing notice) reads it. */
export interface DashboardHealth {
  ok: boolean;
  nodeRed?: boolean;
  mqtt?: boolean;
  tts?: boolean;
  /** The voice recogniser ("Gehoor") is the browser's; the panel reports it from the page itself. */
  memory?: { persistent?: boolean; sessions?: number };
  omnirouteConfigured?: boolean;
  routing?: { ready?: boolean };
  tools?: { available?: number } | number;
  toolCount?: number;
  services?: Record<string, DashboardServiceHealth>;
  state?: Record<string, DashboardStateEntry>;
}

/** One row of GET /api/audit that the Activiteit panel reads. */
export interface ActivityEntry {
  tool?: string;
  sessionId?: string;
  timestamp?: string;
  result?: { ok?: boolean };
}

/** GET /api/audit?limit=N */
export interface ActivityResponse {
  entries: ActivityEntry[];
}

/** POST /api/actions/execute */
export interface ActionResult {
  ok?: boolean;
  error?: string;
}
