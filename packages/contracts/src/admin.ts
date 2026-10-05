import type { PendingConfirmation } from "./chat.js";
import type { Risk } from "./tools.js";

/** One block of GET /api/integrations (the admin screen reads the ones it knows). */
export interface IntegrationStatus {
  online?: boolean;
  configured?: boolean;
  ready?: boolean;
  entities?: number;
  error?: string | null;
  backend?: string;
  updatedAt?: string | null;
}

/** GET /api/integrations */
export interface IntegrationsReport {
  homeAssistant?: IntegrationStatus;
  nodeRed?: IntegrationStatus;
  proxmox?: IntegrationStatus;
  mqtt?: IntegrationStatus;
  tts?: IntegrationStatus;
  shortTermMemory?: IntegrationStatus;
  omniroute?: IntegrationStatus;
  qdrant?: IntegrationStatus;
  longTermMemory?: IntegrationStatus;
  actions?: { enabled: boolean; safeAutomatic?: boolean };
  routing?: { ready?: boolean; enabledModels?: string[] };
}

/** One provider of the free-AI inventory (GET /api/providers). */
export interface ProviderInfo {
  provider: string;
  enabledModels: number;
  cooldownUntil?: string | number | null;
}

/** GET /api/providers */
export interface ProvidersReport {
  freeOnly?: boolean;
  ready: boolean;
  status?: string;
  reason?: string;
  enabledModels?: string[];
  providers?: ProviderInfo[];
}

/** GET /api/gateway */
export interface GatewayReport {
  configured?: boolean;
  online: boolean;
  error?: string;
  memory?: { keyword: boolean; embedding: boolean };
  skills?: { count: number };
  compression?: { enabled: boolean; mode: string };
  cache?: { hits: number; misses: number; entries: number };
}

/** GET /api/audit */
export interface AuditLogEntry {
  id?: string;
  timestamp?: string;
  tool?: string;
  risk?: Risk | string;
  confirmation?: string;
  phase?: string;
  result?: {
    ok?: boolean;
    error?: string;
    verified?: boolean | null;
    accepted?: boolean;
  };
}

/** Wallpaper, widget preview and other small answers of the settings screen. */
export interface WidgetPreviewResult {
  data: WidgetPreviewData;
}
export type WidgetPreviewData = {
  error?: string;
  value?: number | string;
  items?: string[];
};

/** What remembering or forgetting a memory answers: done, refused, or waiting for a confirmation card. */
export interface ConfirmableResult {
  ok: boolean;
  error?: string;
  requiresConfirmation?: boolean;
  action?: PendingConfirmation;
}
