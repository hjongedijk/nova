import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function syncDirectory(file: string): void {
  const descriptor = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Reads a tiny private JSON state file: regular file only (no symlinks), bounded
 * size, plain object accepted by `valid`. Returns undefined when it does not exist.
 * Every other problem throws `unavailable`, and a rename that became visible
 * before its directory sync was acknowledged is settled by syncing here.
 */
export function readStrictState<T>(
  file: string,
  maxBytes: number,
  unavailable: string,
  valid: (state: Record<string, unknown>) => boolean,
): T | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.size > maxBytes) throw new Error(unavailable);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes)
      throw new Error(unavailable);
    const bytes = Buffer.alloc(maxBytes + 1);
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
    if (length > maxBytes) throw new Error(unavailable);
    const parsed: unknown = JSON.parse(
      bytes.subarray(0, length).toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(unavailable);
    const state = parsed as Record<string, unknown>;
    if (!valid(state)) throw new Error(unavailable);
    fs.fsyncSync(descriptor);
    syncDirectory(file);
    return state as T;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Durably replaces the state file (0600, directory 0700); a failed write never leaves a temp file. */
export function writeStrictState(file: string, state: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(state));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    syncDirectory(file);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Cleanup cannot authorize a failed or uncertain write.
    }
  }
}
