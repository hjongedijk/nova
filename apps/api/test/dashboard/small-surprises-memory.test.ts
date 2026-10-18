import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryListResponse, MemoryRecord } from "@nova/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmallSurprisesService } from "../../src/dashboard/small-surprises.service.js";
import { dbStat, stateDoc, stateText } from "../helpers/nova-db.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const now = new Date("2026-10-13T08:00:00Z");
const fact = (
  text = "Mijn verjaardag is op 13 oktober.",
  extra: Partial<MemoryRecord> = {},
): MemoryRecord => ({
  id: "birthday-fact",
  text,
  type: "USER_FACT",
  source: "explicit_user",
  ...extra,
});
function fixture(memories: MemoryRecord[] = [fact()], existingDir?: string) {
  const dir =
    existingDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "nova-memory-birthday-"));
  if (!existingDir) directories.push(dir);
  const state = {
    enabled: true,
    birthday: "",
    focused: false,
    present: true,
    quiet: false,
  };
  const list = vi.fn<
    (limit?: number, offset?: unknown) => Promise<MemoryListResponse>
  >(async () => ({ memories, next: null }));
  const record = vi.fn<
    (event: unknown, at?: Date, workflowId?: string) => { at: string }
  >(() => ({ at: now.toISOString() }));
  const pending = vi.fn(() => false);
  const service = new SmallSurprisesService(
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
          wardrobe: {
            theme: "nova",
            seasonal: false,
            birthday: state.birthday,
          },
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: state.quiet, start: "09:00", end: "12:00" },
          },
          rituals: {
            morning: { enabled: false, time: "08:00" },
            evening: { enabled: false, time: "22:00" },
            checkIn: { enabled: false, afterHours: 4 },
            smallSurprises: { enabled: state.enabled },
          },
        },
      }),
    } as never,
    {
      record,
      focusStatus: () => ({ active: state.focused }),
      findWorkflowEvent: () => undefined,
    } as never,
    { maySpeak: () => state.present } as never,
    { pending, delivered: vi.fn() } as never,
    { configured: true, list } as never,
  );
  return { dir, state, list, record, pending, service };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("explicit remembered own birthdays", () => {
  it.each([
    "Mijn verjaardag is op 13 oktober.",
    "Mijn verjaardag is 13 oktober",
    "Ik ben jarig op 13 oktober.",
    "Ik ben geboren op 1990-10-13.",
    "My birthday is on October 13, 1990.",
    "I was born on 13 October 1990.",
    "My birthday is 1990-10-13!",
  ])(
    "delivers fixed copy from %s without persisting a private date",
    async (text) => {
      const test = fixture([fact(text)]);
      await test.service.checkSchedule(now);
      expect(test.record).toHaveBeenCalledOnce();
      expect(test.record.mock.calls[0]?.[0]).toMatchObject({
        payload: {
          title: "Fijne verjaardag",
          detail: "Maak er een mooie dag van.",
          key: "small-surprise-birthday",
        },
      });
      const progress = path.join(test.dir, "small-surprises-progress.json");
      expect(stateDoc(progress)).toEqual({
        completedDay: "2026-10-13",
      });
      expect(dbStat(progress).mode & 0o777).toBe(0o600);
      expect(stateText(progress)).not.toContain(text);
      await test.service.checkSchedule(now);
      expect(test.list).toHaveBeenCalledOnce();
      expect(test.record).toHaveBeenCalledOnce();
    },
  );

  it.each([
    '"Mijn verjaardag is op 13 oktober."',
    "Mijn moeder is jarig op 13 oktober.",
    "My birthday is on 10/13.",
    "Mijn verjaardag is op 13-10.",
    "Mijn verjaardag is op 31 februari.",
    "Mijn verjaardag is op 29 februari 2025.",
    "Mijn verjaardag is op 13 oktober en mijn zus op 14 oktober.",
    "Hij zei: mijn verjaardag is op 13 oktober.",
    "Mijn verjaardag is op 2026-02-30.",
    "My birthday is on October 13, 0000.",
  ])("does not infer an own birthday from %s", async (text) => {
    const test = fixture([fact(text)]);
    await test.service.checkSchedule(now);
    expect(test.record).not.toHaveBeenCalled();
  });

  it.each([
    { source: "scheduled_summary" },
    { source: "conversation_fact" },
    { type: "PERSON" },
    { archived: true },
    { source: undefined },
  ])(
    "rejects non-explicit/third-party/archived metadata %#",
    async (metadata) => {
      const test = fixture([fact(undefined, metadata)]);
      await test.service.checkSchedule(now);
      expect(test.record).not.toHaveBeenCalled();
    },
  );

  it("accepts a yearless leap-day birthday only on February29", async () => {
    const test = fixture([fact("My birthday is February 29.")]);
    await test.service.checkSchedule(new Date("2028-02-29T09:00:00Z"));
    expect(test.record).toHaveBeenCalledOnce();
  });

  it("suppresses conflicting valid remembered birthdays", async () => {
    const test = fixture([
      fact(),
      fact("Mijn verjaardag is op 14 oktober.", { id: "other" }),
    ]);
    await test.service.checkSchedule(now);
    expect(test.record).not.toHaveBeenCalled();
  });

  it("accepts agreement across different memories and formats", async () => {
    const test = fixture([
      fact(),
      fact("I was born on 1990-10-13.", { id: "other" }),
    ]);
    await test.service.checkSchedule(now);
    expect(test.record).toHaveBeenCalledOnce();
  });

  it.each(["10-13", "10-14"])(
    "manual birthday%s remains synchronous and overrides remembered facts",
    (birthday) => {
      const test = fixture();
      test.state.birthday = birthday;
      expect(test.service.checkSchedule(now)).toBeUndefined();
      expect(test.list).not.toHaveBeenCalled();
      expect(test.record).toHaveBeenCalledTimes(birthday === "10-13" ? 1 : 0);
    },
  );

  it.each(["enabled", "focused", "present", "quiet"] as const)(
    "rechecks%s after memory resolves",
    async (key) => {
      const test = fixture();
      const wait = deferred<MemoryListResponse>();
      test.list.mockImplementation(() => wait.promise);
      const task = test.service.checkSchedule(now);
      test.state[key] = key === "focused" || key === "quiet";
      wait.resolve({ memories: [fact()] });
      await task;
      expect(test.record).not.toHaveBeenCalled();
    },
  );

  it("rechecks manual overrides after retrieval", async () => {
    const test = fixture();
    const wait = deferred<MemoryListResponse>();
    test.list.mockImplementation(() => wait.promise);
    const task = test.service.checkSchedule(now);
    test.state.birthday = "10-14";
    wait.resolve({ memories: [fact()] });
    await task;
    expect(test.record).not.toHaveBeenCalled();
  });

  it("rechecks time and local date rather than emitting yesterday's birthday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = fixture();
    const wait = deferred<MemoryListResponse>();
    test.list.mockImplementation(() => wait.promise);
    const task = test.service.checkSchedule(now);
    vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
    wait.resolve({ memories: [fact()] });
    await task;
    expect(test.record).not.toHaveBeenCalled();
  });

  it("coalesces concurrent checks without duplicate retrieval or greeting", async () => {
    const test = fixture();
    const wait = deferred<MemoryListResponse>();
    test.list.mockImplementation(() => wait.promise);
    const first = test.service.checkSchedule(now);
    expect(test.service.checkSchedule(now)).toBe(first);
    wait.resolve({ memories: [fact()] });
    await first;
    expect(test.list).toHaveBeenCalledOnce();
    expect(test.record).toHaveBeenCalledOnce();
  });

  it("does not deliver a late memory result after service shutdown", async () => {
    const test = fixture();
    const wait = deferred<MemoryListResponse>();
    test.list.mockImplementation(() => wait.promise);
    const task = test.service.checkSchedule(now);
    test.service.onModuleDestroy();
    wait.resolve({ memories: [fact()] });
    await task;
    expect(test.record).not.toHaveBeenCalled();
  });

  it("preserves once-per-day progress after recreating the service", async () => {
    const test = fixture();
    await test.service.checkSchedule(now);
    const restarted = fixture([fact()], test.dir);
    await restarted.service.checkSchedule(now);
    expect(restarted.list).not.toHaveBeenCalled();
    expect(restarted.record).not.toHaveBeenCalled();
  });

  it("does not retrieve memory while opt-out/focus/quiet/absence gates block delivery", async () => {
    for (const overrides of [
      { enabled: false },
      { focused: true },
      { quiet: true },
      { present: false },
    ]) {
      const test = fixture();
      Object.assign(test.state, overrides);
      await test.service.checkSchedule(now);
      expect(test.list).not.toHaveBeenCalled();
      expect(test.record).not.toHaveBeenCalled();
    }
  });

  it("does not cache facts removed before a later eligible day", async () => {
    const test = fixture();
    await test.service.checkSchedule(new Date("2026-10-12T08:00:00Z"));
    test.list.mockResolvedValue({ memories: [], next: null });
    await test.service.checkSchedule(now);
    expect(test.list).toHaveBeenCalledTimes(2);
    expect(test.record).not.toHaveBeenCalled();
  });

  it("reads complete pages before trusting a birthday", async () => {
    const test = fixture();
    test.list
      .mockResolvedValueOnce({ memories: [fact()], next: "cursor" })
      .mockResolvedValueOnce({
        memories: [fact("My birthday is October14.", { id: "ignored" })],
        next: null,
      });
    await test.service.checkSchedule(now);
    expect(test.list).toHaveBeenNthCalledWith(2, 100, "cursor");
    expect(test.record).toHaveBeenCalledOnce();
  });

  it("detects conflicting facts on later pages", async () => {
    const test = fixture();
    test.list
      .mockResolvedValueOnce({ memories: [fact()], next: "cursor" })
      .mockResolvedValueOnce({
        memories: [fact("My birthday is October 14.", { id: "other" })],
        next: null,
      });
    await test.service.checkSchedule(now);
    expect(test.record).not.toHaveBeenCalled();
  });

  it.each([
    "failure",
    "unavailable",
    "repeated",
    "empty",
    "truncated",
    "duplicate",
  ])("fails closed on%s pagination", async (kind) => {
    const test = fixture();
    test.list.mockResolvedValueOnce({ memories: [fact()], next: "cursor" });
    if (kind === "failure")
      test.list.mockRejectedValueOnce(new Error("private diagnostic"));
    if (kind === "unavailable")
      test.list.mockResolvedValueOnce({
        memories: [],
        unavailable: "private diagnostic",
      });
    if (kind === "repeated")
      test.list.mockResolvedValueOnce({
        memories: [fact("irrelevant", { id: "next" })],
        next: "cursor",
      });
    if (kind === "empty")
      test.list.mockResolvedValueOnce({ memories: [], next: "another" });
    if (kind === "duplicate")
      test.list.mockResolvedValueOnce({ memories: [fact()], next: null });
    if (kind === "truncated")
      for (let page = 1; page <= 4; page++)
        test.list.mockResolvedValueOnce({
          memories: [fact("irrelevant", { id: String(page) })],
          next: page,
        });
    await test.service.checkSchedule(now);
    expect(test.record).not.toHaveBeenCalled();
    expect(test.list.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("preserves NewYear and pending milestone paths when memory is unavailable", async () => {
    const test = fixture();
    test.list.mockRejectedValue(new Error("private backend diagnostic"));
    await test.service.checkSchedule(new Date("2027-01-01T09:00:00Z"));
    expect(test.record.mock.calls[0]?.[0]).toMatchObject({
      payload: { title: "Gelukkig nieuwjaar" },
    });
    test.record.mockClear();
    test.pending.mockReturnValue(true);
    await test.service.checkSchedule(now);
    expect(test.record.mock.calls[0]?.[0]).toMatchObject({
      payload: { title: "Honderd chatbeurten" },
    });
  });
});
