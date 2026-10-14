import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import { DailyHighlightService } from "../../src/dashboard/daily-highlight.service.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  enabled: boolean,
  statements: Array<string | { content: string; at: string }>,
  existing?: { dir: string; accepted: Map<string, object> },
) {
  const dir =
    existing?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "nova-highlight-"));
  if (!existing) directories.push(dir);
  const accepted = existing?.accepted ?? new Map<string, object>();
  const record = vi.fn(
    (event: InfrastructureEvent, _now?: Date, workflowId?: string) => {
      const stored = { ...event, seq: accepted.size + 1 };
      if (workflowId) accepted.set(workflowId, stored);
      return stored as object | null;
    },
  );
  const findWorkflowEvent = vi.fn((id: string) => accepted.get(id));
  const auditRecord = vi.fn();
  const service = new DailyHighlightService(
    {
      timezone: "Europe/Amsterdam",
      dataFile: (name: string) => path.join(dir, name),
    } as never,
    {
      get: () => ({
        helperPreferences: {
          autohide: true,
          contrast: false,
          shape: "orb",
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: false, start: "22:00", end: "07:00" },
          },
          rituals: {
            morning: { enabled: false, time: "08:00" },
            evening: { enabled: false, time: "22:00" },
            checkIn: { enabled: false, afterHours: 4 },
            weeklyOverview: { enabled: false, time: "18:00" },
            dailyHighlight: { enabled, time: "20:00" },
          },
        },
      }),
    } as never,
    {
      allMessages: () =>
        statements.map((item) => ({
          role: "user",
          content: typeof item === "string" ? item : item.content,
          at: typeof item === "string" ? "2026-10-13T12:00:00.000Z" : item.at,
        })),
    } as never,
    { record, findWorkflowEvent } as never,
    { record: auditRecord } as never,
  );
  return { dir, accepted, record, findWorkflowEvent, auditRecord, service };
}

describe("opt-in daily highlight", () => {
  const before = new Date("2026-10-13T17:59:00Z");
  const due = new Date("2026-10-13T18:00:00Z");

  it("waits for local evening and emits one fixed, non-identifying sentence", async () => {
    const disabled = fixture(false, ["Ik heb mijn project afgerond."]);
    await disabled.service.checkSchedule(due);
    expect(disabled.record).not.toHaveBeenCalled();

    const enabled = fixture(true, ["Ik heb mijn project afgerond."]);
    await enabled.service.checkSchedule(before);
    expect(enabled.record).not.toHaveBeenCalled();
    await enabled.service.checkSchedule(due);
    await enabled.service.checkSchedule(due);
    expect(enabled.record).toHaveBeenCalledOnce();
    expect(enabled.record.mock.calls[0]?.[0].payload.title).toBe(
      "Hoogtepunt van vandaag",
    );
    expect(enabled.record.mock.calls[0]?.[0].payload.detail).toBe(
      "Je rondde vandaag een project af.",
    );
    expect(enabled.auditRecord.mock.calls[0]?.[0]).toMatchObject({
      tool: "proactive_daily_highlight",
      arguments: { day: "2026-10-13" },
      result: { ok: true },
    });
    expect(
      JSON.stringify(enabled.auditRecord.mock.calls[0]?.[0]),
    ).not.toContain("project");
    const progress = path.join(enabled.dir, "daily-highlight-progress.json");
    expect(JSON.parse(fs.readFileSync(progress, "utf8"))).toEqual({
      completedDay: "2026-10-13",
    });
    expect(fs.statSync(progress).mode & 0o777).toBe(0o600);
  });

  it("stays quiet without explicit positive evidence", async () => {
    const instance = fixture(true, [
      "Wat is de status?",
      "Dat is niet gelukt.",
      "Is mijn operatie klaar?",
    ]);
    await instance.service.checkSchedule(due);
    expect(instance.record).not.toHaveBeenCalled();
  });

  it("keeps private detail out and chooses the newest dated statement across sessions", async () => {
    const newer = {
      content: "Ik heb mijn project afgerond. Mijn dossier is privé.",
      at: "2026-10-13T16:00:00.000Z",
    };
    const older = Array.from({ length: 101 }, () => ({
      content: "Vandaag had ik een vraag.",
      at: "2026-10-13T10:00:00.000Z",
    }));
    const instance = fixture(true, [newer, ...older]);
    await instance.service.checkSchedule(due);
    expect(instance.record.mock.calls[0]?.[0].payload.detail).toBe(
      "Je rondde vandaag een project af.",
    );
    expect(JSON.stringify(instance.record.mock.calls[0]?.[0])).not.toContain(
      "dossier",
    );
  });

  it("pauses before the first delivery when saved progress is corrupt", async () => {
    const instance = fixture(true, ["Ik heb mijn project afgerond."]);
    const progress = path.join(instance.dir, "daily-highlight-progress.json");
    fs.writeFileSync(progress, "{broken");
    await instance.service.checkSchedule(due);
    await instance.service.checkSchedule(new Date(due.getTime() + 6 * 60_000));
    expect(instance.record).not.toHaveBeenCalled();
    expect(instance.auditRecord).not.toHaveBeenCalled();
    expect(fs.readFileSync(progress, "utf8")).toBe("{broken");
  });

  it("does not repeat an accepted highlight after audit failure or restart", async () => {
    const instance = fixture(true, ["Ik heb mijn project afgerond."]);
    instance.auditRecord.mockImplementationOnce(() => {
      throw new Error("audit unavailable");
    });
    await instance.service.checkSchedule(due);
    await instance.service.checkSchedule(new Date(due.getTime() + 6 * 60_000));
    expect(instance.record).toHaveBeenCalledOnce();
    const expectedId =
      "nova-workflow:" +
      createHash("sha256")
        .update("nova:daily-highlight:2026-10-13")
        .digest("hex");
    expect(instance.record.mock.calls[0]?.[2]).toBe(expectedId);
    expect(instance.accepted.has(expectedId)).toBe(true);
    // Lose only the completion marker: durable acceptance must remain authoritative.
    fs.rmSync(path.join(instance.dir, "daily-highlight-progress.json"), {
      force: true,
    });
    const restarted = fixture(
      true,
      ["Ik heb mijn project afgerond."],
      instance,
    );
    await restarted.service.checkSchedule(
      new Date(due.getTime() + 12 * 60_000),
    );
    expect(restarted.findWorkflowEvent).toHaveBeenCalledWith(expectedId);
    expect(restarted.record).not.toHaveBeenCalled();
  });

  it("retries a rejected feed delivery instead of marking the day completed", async () => {
    const instance = fixture(true, ["Ik heb mijn project afgerond."]);
    instance.record.mockReturnValueOnce(null);
    await instance.service.checkSchedule(due);
    const progress = path.join(instance.dir, "daily-highlight-progress.json");
    expect(fs.existsSync(progress)).toBe(false);
    await instance.service.checkSchedule(new Date(due.getTime() + 6 * 60_000));
    expect(instance.record).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(progress, "utf8"))).toEqual({
      completedDay: "2026-10-13",
    });
  });
});
