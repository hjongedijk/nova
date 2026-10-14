import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMilestoneService } from "../../src/memory/conversation-milestone.service.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-milestone-"));
  directories.push(dir);
  const file = path.join(dir, "conversation-milestone.json");
  const preferences = { enabled };
  const config = { dataFile: (name: string) => path.join(dir, name) };
  const settings = {
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
          smallSurprises: preferences,
        },
      },
    }),
  };
  const create = () =>
    new ConversationMilestoneService(config as never, settings as never);
  const seed = (turns: number, delivered = false) =>
    fs.writeFileSync(file, JSON.stringify({ version: 1, turns, delivered }), {
      mode: 0o600,
    });
  return { dir, file, preferences, create, seed, service: create() };
}
const unavailable = /^Conversation milestone unavailable$/;
const rawFailure = () => new Error("private diagnostic /private/path");

describe("private opt-in conversation milestone", () => {
  it("counts across instances without content or history and reaches one pending hundredth turn", () => {
    const { file, service, create, dir } = fixture();
    expect(service.pending()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    for (let index = 0; index < 99; index++) create().completedTurn();
    expect(create().pending()).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      turns: 99,
      delivered: false,
    });
    create().completedTurn();
    expect(create().pending()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["conversation-milestone.json"]);
    const write = vi.spyOn(fs, "writeFileSync");
    for (let index = 0; index < 5; index++) create().completedTurn();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      turns: 100,
      delivered: false,
    });
  });

  it("delivers only at the target and persists idempotent completion", () => {
    const { service, create, file, seed } = fixture();
    service.delivered();
    expect(fs.existsSync(file)).toBe(false);
    seed(99);
    service.delivered();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).delivered).toBe(false);
    service.completedTurn();
    service.delivered();
    expect(create().pending()).toBe(false);
    const write = vi.spyOn(fs, "writeFileSync");
    create().delivered();
    create().completedTurn();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      turns: 100,
      delivered: true,
    });
  });

  it("writes nothing while disabled and resumes only newly completed turns", () => {
    const { service, file, preferences, seed } = fixture(false);
    service.completedTurn();
    service.delivered();
    expect(service.pending()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    seed(99);
    const before = fs.readFileSync(file, "utf8");
    service.completedTurn();
    service.delivered();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    preferences.enabled = true;
    service.completedTurn();
    expect(service.pending()).toBe(true);
  });

  const malformed = [
    "{broken",
    "null",
    "[]",
    "{}",
    "x".repeat(2049),
    ...[
      { version: 2, turns: 1, delivered: false },
      { version: 1, turns: -1, delivered: false },
      { version: 1, turns: 101, delivered: false },
      { version: 1, turns: 1.5, delivered: false },
      { version: 1, turns: "99", delivered: false },
      { version: 1, turns: 99, delivered: true },
      { version: 1, turns: 100, delivered: "true" },
      { version: 1, turns: 1, delivered: false, content: "private" },
    ].map((state) => JSON.stringify(state)),
  ];
  it.each(malformed)(
    "rejects malformed/oversized state case %# for every operation without overwriting",
    (content) => {
      const { service, file } = fixture();
      fs.writeFileSync(file, content);
      for (const operation of [
        () => service.completedTurn(),
        () => service.pending(),
        () => service.delivered(),
      ])
        expect(operation).toThrow(unavailable);
      expect(fs.readFileSync(file, "utf8")).toBe(content);
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, turns: 99, delivered: false }),
      );
      service.completedTurn();
      expect(service.pending()).toBe(true);
    },
  );

  it.each(["directory", "symlink"])(
    "rejects a %s instead of a counter file",
    (kind) => {
      const { service, file, dir } = fixture();
      if (kind === "directory") fs.mkdirSync(file);
      else fs.symlinkSync(path.join(dir, "missing-target"), file);
      expect(() => service.completedTurn()).toThrow(unavailable);
      expect(() => service.pending()).toThrow(unavailable);
      expect(() => service.delivered()).toThrow(unavailable);
    },
  );

  it.each(["open", "write", "file-sync", "rename"])(
    "fails safely on %s and recovers without a permanent pause",
    (failure) => {
      const { service, file, dir } = fixture();
      if (failure === "open")
        vi.spyOn(fs, "openSync").mockImplementation(() => {
          throw rawFailure();
        });
      if (failure === "write")
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
          throw rawFailure();
        });
      if (failure === "file-sync")
        vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
          throw rawFailure();
        });
      if (failure === "rename")
        vi.spyOn(fs, "renameSync").mockImplementation(() => {
          throw rawFailure();
        });
      expect(() => service.completedTurn()).toThrow(unavailable);
      vi.restoreAllMocks();
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
      service.completedTurn();
      expect(JSON.parse(fs.readFileSync(file, "utf8")).turns).toBe(1);
    },
  );

  it("rereads a count rename that succeeded before acknowledgement failed", () => {
    const { service, file, seed, create } = fixture();
    seed(99);
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      throw rawFailure();
    });
    expect(() => service.completedTurn()).toThrow(unavailable);
    vi.restoreAllMocks();
    expect(create().pending()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).turns).toBe(100);
  });

  it("settles a delivery rename after failed directory sync without repeating delivery", () => {
    const { service, file, seed, create } = fixture();
    seed(100);
    const sync = fs.fsyncSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      if (++calls === 4) throw rawFailure();
      sync(descriptor);
    });
    expect(() => service.delivered()).toThrow(unavailable);
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).delivered).toBe(true);
    expect(create().pending()).toBe(false);
  });

  it("does not authorize delivery when persisted state cannot be read or synchronized", () => {
    const { service, seed } = fixture();
    seed(100);
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      throw rawFailure();
    });
    expect(() => service.pending()).toThrow(unavailable);
    vi.restoreAllMocks();
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw rawFailure();
    });
    expect(() => service.pending()).toThrow(unavailable);
    expect(() => service.delivered()).toThrow(unavailable);
    vi.restoreAllMocks();
    expect(service.pending()).toBe(true);
  });
});
