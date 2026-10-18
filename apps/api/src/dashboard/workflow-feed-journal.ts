import { readJsonState, writeJsonState } from "../core/db/json-state.js";
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
      const parsed = readJsonState(this.file) as
        { version?: unknown; entries?: unknown } | undefined;
      if (parsed !== undefined) {
        if (!parsed || typeof parsed !== "object" || parsed.version !== 1)
          throw new Error("Invalid workflow feed history");
        entries = parsed.entries;
      }
    } catch (error) {
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
    this.entries = entries as WorkflowNotice[];
    this.loaded = true;
    return this.entries;
  }

  find(id: string): FeedEvent | undefined {
    return this.read().find((entry) => entry.id === id)?.event;
  }

  accept(id: string, event: FeedEvent): void {
    const next = [...this.read(), { id, event: { ...event } }];
    // Keep one receipt per built-in ritual even when unrelated workflow traffic fills the journal.
    // Otherwise a failed completion-marker write could replay the same day/week after restart.
    const rituals = new Map<string, string>();
    for (const row of next) {
      const family =
        /^(daily-highlight|weekly-overview)-\d{4}-\d{2}-\d{2}$/.exec(
          row.event.key ?? "",
        )?.[1];
      if (family) rituals.set(family, row.id);
      if (row.event.key === "small-surprise-conversation-100")
        rituals.set("conversation-milestone", row.id);
    }
    const retained = new Set(rituals.values());
    while (next.length > MAX_WORKFLOW_NOTICES) {
      const oldest = next.findIndex((row) => !retained.has(row.id));
      next.splice(oldest, 1);
    }
    try {
      writeJsonState(this.file, { version: 1, entries: next }, "dir");
      this.entries = next;
    } catch {
      this.loaded = false;
      throw new Error("Workflow feed history unavailable");
    }
  }
}
