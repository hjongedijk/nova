import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

function syncDirectory(file: string): void {
  const descriptor = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) throw new Error(UNAVAILABLE);
    const descriptor = fs.openSync(
      this.file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_BYTES)
        throw new Error(UNAVAILABLE);
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(
          descriptor,
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES) throw new Error(UNAVAILABLE);
      const parsed: unknown = JSON.parse(
        bytes.subarray(0, length).toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(UNAVAILABLE);
      const state = parsed as Record<string, unknown>;
      if (
        Object.keys(state).sort().join(",") !==
          "attempts,lastAttemptAt,period,version" ||
        state.version !== 1 ||
        !validPeriod(state.period) ||
        !Number.isSafeInteger(state.attempts) ||
        (state.attempts as number) < 1 ||
        (state.attempts as number) > MAX_ATTEMPTS ||
        !validTime(state.lastAttemptAt)
      )
        throw new Error(UNAVAILABLE);
      fs.fsyncSync(descriptor);
      syncDirectory(this.file);
      return state as unknown as AttemptState;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private write(state: AttemptState): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(state));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
      syncDirectory(this.file);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Preserve the reservation failure; never authorize work after an uncertain save.
      }
    }
  }
}
