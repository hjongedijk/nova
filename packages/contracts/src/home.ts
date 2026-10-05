/** One Home Assistant entity as NOVA's catalog holds it (state plus registry data). */
export interface HaEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated?: string;
  last_changed?: string;
  domain: string;
  friendly_name: string;
  area_id: string | null;
  area: string | null;
  device_id: string | null;
  device: string | null;
  aliases: string[];
  capabilities: string[];
  supported_features: number;
  synced_at: string | null;
  last_seen: string | null;
}

/** GET /api/entities */
export interface EntitiesResponse {
  entities: HaEntity[];
  syncedAt: string | null;
}

/** What /api/health reports for Home Assistant. */
export interface HomeHealth {
  configured: boolean;
  online: boolean;
  stale: boolean;
  syncedAt: string | null;
  entities: number;
  sonos: boolean;
  musicAssistant: boolean;
  error: string | null;
}

/** The "Huis" panel. Sections without data are null or empty. */
export interface HomeSummary {
  people: { name: string; state: string }[];
  lights: { on: number; total: number } | null;
  switches: { on: number; total: number } | null;
  climate: { name: string; current: number | null; target: number | null }[];
  temperatures: { name: string; value: number; unit: string }[];
  updates: string[];
  lists: { name: string; open: number }[];
  playing: string[];
}
