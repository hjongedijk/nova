/** Server-side limits of a takeover session. The agent enforces its own TTL too; these are NOVA's. */
export const DESKTOP_LIMITS = {
  minTtlSeconds: 30,
  maxTtlSeconds: 900,
  maxActions: 100,
  /** No look or action for this long ends the session. */
  idleTimeoutMs: 120_000,
  /** This many failed actions in a row end the session. */
  maxErrorsInRow: 3,
  /** Observe then act: after this many actions NOVA must look at the screen again. */
  maxActionsPerObservation: 6,
  maxObservations: 60,
  cacheTtlMs: 10_000,
  cacheEntries: 4,
  defaultMaxWidth: 1280,
  minMaxWidth: 320,
  maxMaxWidth: 1920,
  maxScreenshotBytes: 6_000_000,
  maxTypedCharacters: 300,
} as const;
