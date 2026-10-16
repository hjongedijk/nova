import { readStrictState, writeStrictState } from "./strict-state-file.js";

const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_BYTES = 2048;
const UNAVAILABLE = "Scheduled attempt budget unavailable";

interface AttemptState {
  version: 1;
  period: string;
  attempts: number;
  lastAttemptAt: number;
}

function validPeriod(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function validTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}

/** Reserve before work: failures spend at most three attempts per period, including across restarts. */
export class ScheduledAttemptBudget {
  constructor(private readonly file: string) {}

  reserve(period: string, nowMs: number): boolean {
    if (!validPeriod(period) || !validTime(nowMs))
      throw new Error("Invalid scheduled attempt reservation");
    try {
      // Always reread and sync: a prior rename may have succeeded without acknowledgement.
      const previous = this.read();
      if (
        previous &&
        (period < previous.period || nowMs < previous.lastAttemptAt)
      )
        return false;
      const attempts = previous?.period === period ? previous.attempts : 0;
      if (
        attempts >= MAX_ATTEMPTS ||
        (attempts > 0 && nowMs - previous!.lastAttemptAt < RETRY_MS)
      )
        return false;
      this.write({
        version: 1,
        period,
        attempts: attempts + 1,
        lastAttemptAt: nowMs,
      });
      return true;
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }

  private read(): AttemptState | undefined {
    return readStrictState<AttemptState>(
      this.file,
      MAX_BYTES,
      UNAVAILABLE,
      (state) =>
        Object.keys(state).sort().join(",") ===
          "attempts,lastAttemptAt,period,version" &&
        state.version === 1 &&
        validPeriod(state.period) &&
        Number.isSafeInteger(state.attempts) &&
        (state.attempts as number) >= 1 &&
        (state.attempts as number) <= MAX_ATTEMPTS &&
        validTime(state.lastAttemptAt),
    );
  }

  private write(state: AttemptState): void {
    writeStrictState(this.file, state);
  }
}
