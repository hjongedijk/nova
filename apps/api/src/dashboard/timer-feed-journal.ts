import { writePrivateJson } from "../settings/history-file.js";
import fs from "node:fs";
import type { FeedEvent } from "@nova/contracts";

const MAX_TIMER_NOTICES = 200;
type TimerNotice = { id: string; event: FeedEvent };

/** Private, bounded timer acceptance history. IDs survive producer acknowledgement failures. */
export class TimerFeedJournal {
  private entries: TimerNotice[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  read(): readonly TimerNotice[] {
    if (this.loaded) return this.entries;
    let entries: unknown = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        version?: unknown;
        entries?: unknown;
      };
      if (parsed.version !== 1) throw new Error("Invalid timer feed history");
      entries = parsed.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Timer feed history unavailable", { cause: error });
    }
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_TIMER_NOTICES ||
      entries.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          typeof row.id !== "string" ||
          !/^[a-f0-9]{8}:\d+$/.test(row.id) ||
          !row.event ||
          row.event.kind !== "timer" ||
          !Number.isSafeInteger(row.event.seq) ||
          row.event.seq <= 0 ||
          typeof row.event.title !== "string" ||
          row.event.title.length > 120 ||
          typeof row.event.detail !== "string" ||
          row.event.detail.length > 240 ||
          typeof row.event.at !== "string" ||
          !Number.isFinite(Date.parse(row.event.at)) ||
          typeof row.event.label !== "string" ||
          row.event.label.length > 60,
      )
    )
      throw new Error("Timer feed history unavailable");
    if (new Set(entries.map((row) => row.id)).size !== entries.length)
      throw new Error("Timer feed history unavailable");
    this.entries = entries as TimerNotice[];
    this.loaded = true;
    return this.entries;
  }

  find(id: string): FeedEvent | undefined {
    return this.read().find((entry) => entry.id === id)?.event;
  }

  accept(id: string, event: FeedEvent): void {
    const next = [...this.read(), { id, event: { ...event } }].slice(
      -MAX_TIMER_NOTICES,
    );
    try {
      writePrivateJson(this.file, { version: 1, entries: next }, "dir");
      this.entries = next;
    } catch {
      throw new Error("Timer feed history unavailable");
    }
  }
}
