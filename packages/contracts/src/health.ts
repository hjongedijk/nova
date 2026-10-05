/** GET /api/health */
export interface HealthResponse {
  ok: boolean;
  name: "nova";
  version: string;
  uptimeSeconds: number;
  /** Per dependency: reachable or not. Filled in as modules are ported. */
  services: Record<string, ServiceHealth>;
}

export interface ServiceHealth {
  online: boolean;
  detail?: string;
}
