import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dbStat,
  failStateWrites,
  seedState,
  stateDoc,
  stateExists,
} from "../helpers/nova-db.js";
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

describe("durable scheduled attempt budget", () => {
  it("reserves privately before work and enforces backoff across new instances", () => {
    const { file, budget, dir } = fixture();
    expect(budget.reserve(day, now)).toBe(true);
    expect(stateDoc(file)).toEqual({
      version: 1,
      period: day,
      attempts: 1,
      lastAttemptAt: now,
    });
    expect(dbStat(file).mode & 0o777).toBe(0o600);
    expect(new ScheduledAttemptBudget(file).reserve(day, now + retry - 1)).toBe(
      false,
    );
    expect(new ScheduledAttemptBudget(file).reserve(day, now + retry)).toBe(
      true,
    );
    expect(
      fs.readdirSync(dir).filter((name) => name === "attempts.json"),
    ).toEqual([]);
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
    expect(stateDoc(file)).toMatchObject({
      period: "2026-10-15",
      attempts: 1,
    });
  });

  it("cannot reset the budget with an older period or a backwards clock", () => {
    const { budget, file } = fixture();
    expect(budget.reserve(day, now)).toBe(true);
    const saved = stateDoc(file);
    expect(budget.reserve("2026-10-13", now + retry)).toBe(false);
    expect(budget.reserve("2026-10-15", now - 1)).toBe(false);
    expect(budget.reserve(day, now - 1)).toBe(false);
    expect(stateDoc(file)).toEqual(saved);
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
    expect(stateExists(file)).toBe(false);
  });

  it.each([
    "{broken",
    null,
    [],
    {},
    {
      version: 1,
      period: "2026-02-30",
      attempts: 1,
      lastAttemptAt: now,
    },
    { version: 1, period: day, attempts: 4, lastAttemptAt: now },
    { version: 1, period: day, attempts: 0, lastAttemptAt: now },
    { version: 1, period: day, attempts: 1, lastAttemptAt: -1 },
    { version: 2, period: day, attempts: 1, lastAttemptAt: now },
    {
      version: 1,
      period: day,
      attempts: 1,
      lastAttemptAt: now,
      content: "private",
    },
  ])("fails closed on malformed stored state case %#", (content) => {
    const { budget, file } = fixture();
    seedState(file, content);
    expect(() => budget.reserve(day, now)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    expect(stateDoc(file)).toEqual(content);
  });

  it("does not authorize work when the reservation cannot be stored, then recovers", () => {
    const { budget, file } = fixture();
    const failure = failStateWrites(
      file,
      "private raw diagnostic /secret/path",
    );
    expect(() => budget.reserve(day, now)).toThrow(
      /^Scheduled attempt budget unavailable$/,
    );
    failure.mockRestore();
    expect(stateExists(file)).toBe(false);
    expect(budget.reserve(day, now)).toBe(true);
  });

  it("imports a legacy attempts file once and keeps its budget", () => {
    const { budget, file, dir } = fixture();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        period: day,
        attempts: 2,
        lastAttemptAt: now,
      }),
    );
    expect(budget.reserve(day, now + retry - 1)).toBe(false);
    expect(budget.reserve(day, now + retry)).toBe(true);
    expect(stateDoc(file)).toMatchObject({ attempts: 3 });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.migrated`)).toBe(true);
    expect(fs.readdirSync(dir)).toContain("nova.db");
  });

  it("sets a corrupt legacy attempts file aside instead of crashing", () => {
    const { budget, file } = fixture();
    fs.writeFileSync(file, "{broken");
    expect(budget.reserve(day, now)).toBe(true);
    expect(fs.readFileSync(`${file}.corrupt`, "utf8")).toBe("{broken");
  });
});
