import fs from "node:fs";
import path from "node:path";
import type { FeedEvent } from "@nova/contracts";

const MAX_WORKFLOW_NOTICES = 200;
type WorkflowNotice = { id: string; event: FeedEvent };

/** Private, bounded workflow acceptance history. IDs survive producer acknowledgement failures. */
export class WorkflowFeedJournal {
  private entries: WorkflowNotice[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  read(): readonly WorkflowNotice[] {
    if (this.loaded) return this.entries;
    let entries: unknown = [];
    try {
      const stats = fs.statSync(this.file);
      if (!stats.isFile() || stats.size > 1024 * 1024)
        throw new Error("Invalid workflow feed history");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        version?: unknown;
        entries?: unknown;
      };
      if (parsed.version !== 1)
        throw new Error("Invalid workflow feed history");
      entries = parsed.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Workflow feed history unavailable", { cause: error });
    }
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_WORKFLOW_NOTICES ||
      entries.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          typeof row.id !== "string" ||
          !/^nova-workflow:[a-f0-9]{64}$/.test(row.id) ||
          !row.event ||
          row.event.kind !== "alert" ||
          !Number.isSafeInteger(row.event.seq) ||
          row.event.seq <= 0 ||
          typeof row.event.title !== "string" ||
          !row.event.title.length ||
          row.event.title.length > 120 ||
          typeof row.event.detail !== "string" ||
          row.event.detail.length > 240 ||
          typeof row.event.at !== "string" ||
          !Number.isFinite(Date.parse(row.event.at)) ||
          !["info", "warning", "critical"].includes(row.event.severity) ||
          (row.event.key !== undefined &&
            (typeof row.event.key !== "string" || row.event.key.length > 80)) ||
          (row.event.deliveryMode !== undefined &&
            !["screen", "helper", "speak"].includes(row.event.deliveryMode)) ||
          (row.event.speakAllowed !== undefined &&
            typeof row.event.speakAllowed !== "boolean"),
      )
    )
      throw new Error("Workflow feed history unavailable");
    if (
      new Set(entries.map((row) => row.id)).size !== entries.length ||
      new Set(entries.map((row) => row.event.seq)).size !== entries.length
    )
      throw new Error("Workflow feed history unavailable");
    // Also settle an earlier rename whose directory sync failed before acknowledgement.
    if (fs.existsSync(this.file)) {
      const descriptor = fs.openSync(this.file, "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
    this.entries = entries as WorkflowNotice[];
    this.loaded = true;
    return this.entries;
  }

  find(id: string): FeedEvent | undefined {
    return this.read().find((entry) => entry.id === id)?.event;
  }

  accept(id: string, event: FeedEvent): void {
    const next = [...this.read(), { id, event: { ...event } }].slice(
      -MAX_WORKFLOW_NOTICES,
    );
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: 1, entries: next }),
        { mode: 0o600 },
      );
      fs.chmodSync(temporary, 0o600);
      const descriptor = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      this.entries = next;
    } catch {
      this.loaded = false;
      throw new Error("Workflow feed history unavailable");
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* retain the original failure */
      }
    }
  }
}
