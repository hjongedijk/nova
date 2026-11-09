/** Server-side limits of a takeover session. The agent enforces its own TTL too; these are NOVA's. */
export const DESKTOP_LIMITS = {
  minTtlSeconds: 30,
  maxTtlSeconds: 1800,
  maxActions: 300,
  /** No look or action for this long ends the session. */
  idleTimeoutMs: 300_000,
  /** This many failed actions in a row end the session. */
  maxErrorsInRow: 3,
  /** Observe then act: after this many actions NOVA must look at the screen again. */
  maxActionsPerObservation: 6,
  maxObservations: 200,
  cacheTtlMs: 10_000,
  cacheEntries: 4,
  defaultMaxWidth: 1280,
  minMaxWidth: 320,
  maxMaxWidth: 1920,
  maxScreenshotBytes: 6_000_000,
  /** Same cap as the Windows agent (UTF-16 units). */
  maxTypedCharacters: 4000,
} as const;
