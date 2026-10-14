import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledAttemptBudget } from "../../src/dashboard/scheduled-attempt-budget.js";

const directories: string[] = [];
const day = "2026-10-14";
const now = Date.parse("2026-10-14T10:00:00Z");
const retry = 5 * 60_000;
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-attempt-budget-"));
  directories.push(dir);
  const file = path.join(dir, "attempts.json");
  return { dir, file, budget: new ScheduledAttemptBudget(file) };
}
const unavailable = () =>
  new Error("private raw storage diagnostic /secret/path");

describe("durable scheduled attempt budget", () => {
  it("reserves privately before work and enforces backoff across new instances", () => {
    const { file, budget, dir } = fixture();
    expect(budget.reserve(day, now)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      period: day,
      attempts: 1,
      lastAttemptAt: now,
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new ScheduledAttemptBudget(file).reserve(day, now + retry - 1)).toBe(
      false,
    );
    expect(new ScheduledAttemptBudget(file).reserve(day, now + retry)).toBe(
      true,
    );
    expect(fs.readdirSync(dir)).toEqual(["attempts.json"]);
  });

  it("caps failures at three across restarts and resets only for a newer period", () => {
    const { file } = fixture();
    for (let index = 0; index < 3; index++)
      expect(
        new ScheduledAttemptBudget(file).reserve(day, now + index * retry),
      ).toBe(true);
    expect(
      new ScheduledAttemptBudget(file).reserve(day, now + 10 * retry),
    ).toBe(false);
    expect(
      new ScheduledAttemptBudget(file).reserve(
        "2026-10-15",
        now + 24 * 60 * 60_000,
      ),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      period: "2026-10-15",
      attempts: 1,
    });
  });

  it("cannot reset the budget with an older period or a backwards clock", () => {
    const { budget, file } = fixture();
    expect(budget.reserve(day, now)).toBe(true);
    const saved = fs.readFileSync(file, "utf8");
    expect(budget.reserve("2026-10-13", now + retry)).toBe(false);
    expect(budget.reserve("2026-10-15", now - 1)).toBe(false);
    expect(budget.reserve(day, now - 1)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
  });

  it.each([
    ["2026-02-30", now],
    ["2026-1-01", now],
    ["private", now],
    [day, -1],
    [day, NaN],
    [day, Infinity],
    [day, 0.5],
    [day, 8_640_000_000_000_001],
  ])("rejects invalid inputs %s / %s without writing", (period, timestamp) => {
    const { budget, file } = fixture();
    expect(() => budget.reserve(period as string, timestamp as number)).toThrow(
      "Invalid scheduled attempt reservation",
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    "{broken",
    "null",
    "[]",
    "{}",
    "x".repeat(2049),
    JSON.stringify({
      version: 1,
      period: "2026-02-30",
      attempts: 1,
      lastAttemptAt: now,
    }),
    JSON.stringify({
      version: 1,
      period: day,
      attempts: 4,
      lastAttemptAt: now,
    }),
    JSON.stringify({
      version: 1,
      period: day,
      attempts: 0,
      lastAttemptAt: now,
    }),
    JSON.stringify({ version: 1, period: day, attempts: 1, lastAttemptAt: -1 }),
    JSON.stringify({
      version: 2,
      period: day,
      attempts: 1,
      lastAttemptAt: now,
    }),
    JSON.stringify({
      version: 1,
      period: day,
      attempts: 1,
      lastAttemptAt: now,
      content: "private",
    }),
  ])("fails closed on malformed or oversized state case %#", (content) => {
    const { budget, file } = fixture();
    fs.writeFileSync(file, content);
    expect(() => budget.reserve(day, now)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it.each(["directory", "symlink"])(
    "rejects a %s instead of treating it as missing",
    (kind) => {
      const { budget, file, dir } = fixture();
      if (kind === "directory") fs.mkdirSync(file);
      else {
        const target = path.join(dir, "missing-target");
        fs.symlinkSync(target, file);
      }
      expect(() => budget.reserve(day, now)).toThrow(
        /^Scheduled attempt budget unavailable$/,
      );
    },
  );

  it("fails closed on unreadable persisted state without exposing diagnostics", () => {
    const { budget, file } = fixture();
    budget.reserve(day, now);
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      throw unavailable();
    });
    expect(() =>
      new ScheduledAttemptBudget(file).reserve(day, now + retry),
    ).toThrow(/^Scheduled attempt budget unavailable$/);
  });

  it.each(["open", "write", "file-sync", "rename"])(
    "does not authorize work after %s failure and removes temporary files",
    (failure) => {
      const { budget, file, dir } = fixture();
      if (failure === "open")
        vi.spyOn(fs, "openSync").mockImplementation(() => {
          throw unavailable();
        });
      if (failure === "write")
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
          throw unavailable();
        });
      if (failure === "file-sync")
        vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
          throw unavailable();
        });
      if (failure === "rename")
        vi.spyOn(fs, "renameSync").mockImplementation(() => {
          throw unavailable();
        });
      expect(() => budget.reserve(day, now)).toThrow(
        /^Scheduled attempt budget unavailable$/,
      );
      vi.restoreAllMocks();
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(budget.reserve(day, now)).toBe(true);
    },
  );

  it("settles uncertain directory-sync acknowledgement before allowing another attempt", () => {
    const { budget, file, dir } = fixture();
    const sync = fs.fsyncSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      if (++calls === 2) throw unavailable();
      sync(descriptor);
    });
    expect(() => budget.reserve(day, now)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      attempts: 1,
    });
    expect(budget.reserve(day, now)).toBe(false);
    expect(new ScheduledAttemptBudget(file).reserve(day, now + retry)).toBe(
      true,
    );
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      attempts: 2,
    });
    expect(fs.readdirSync(dir)).toEqual(["attempts.json"]);
  });

  it("rereads a rename that succeeded before throwing instead of replaying its slot", () => {
    const { budget, file } = fixture();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      throw unavailable();
    });
    expect(() => budget.reserve(day, now)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    vi.restoreAllMocks();
    expect(budget.reserve(day, now + retry - 1)).toBe(false);
    expect(budget.reserve(day, now + retry)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      attempts: 2,
    });
  });

  it("does not authorize work while synchronization of existing state fails", () => {
    const { budget, file } = fixture();
    budget.reserve(day, now);
    const saved = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw unavailable();
    });
    expect(() => budget.reserve(day, now + retry)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    vi.restoreAllMocks();
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
  });
});
