import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutonomyController } from "../../src/planning/autonomy/autonomy.controller.js";
import { AutonomyService } from "../../src/planning/autonomy/autonomy.service.js";
import { AutonomyStore } from "../../src/planning/autonomy/autonomy.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { ToolsService } from "../../src/tools/tools.service.js";

type Risk = "READ_ONLY" | "SAFE" | "CONFIRM" | "DANGEROUS";
let dir: string;
let clock: number;
const emitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const audit = { record: vi.fn() };
const catalog: Record<string, Risk> = {
  read_a: "READ_ONLY",
  read_b: "READ_ONLY",
  do_safe: "SAFE",
  do_confirm: "CONFIRM",
  do_danger: "DANGEROUS",
};
type Exec = (
  name: string,
  args: unknown,
  session: string,
  approved: unknown,
  always: boolean,
  options: { readOnlyOnly?: boolean },
) => Promise<Record<string, unknown>>;
let handler: Exec;
const execute = vi.fn((...a: Parameters<Exec>) => handler(...a));
const tools = {
  list: () =>
    Object.entries(catalog).map(([name, risk]) => ({
      name,
      risk,
      enabled: true,
    })),
  execute,
} as unknown as ToolsService;

function boot() {
  const config = { dataFile: (n: string) => path.join(dir, n) } as NovaConfig;
  const service = new AutonomyService(
    new AutonomyStore(config),
    tools,
    audit as never,
    {
      emit: (e: { topic: string; payload: Record<string, unknown> }) =>
        emitted.push(e),
    } as never,
  );
  service.now = () => clock;
  service.recover();
  return service;
}
const file = () => path.join(dir, "autonomy-tasks.json");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-autonomy-"));
  clock = Date.parse("2026-10-16T10:00:00Z");
  emitted.length = 0;
  execute.mockClear();
  audit.record.mockClear();
  handler = async () => ({ ok: true, result: "klaar" });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("autonomous scheduled workflow", () => {
  it("runs a delayed two-step task by itself, persists 0600 and notifies", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Ochtendcheck",
      delaySeconds: 600,
      steps: [{ tool: "read_a", args: { q: 1 } }, { tool: "read_b" }],
    });
    await svc.tick();
    expect(execute).not.toHaveBeenCalled();
    clock += 600_000;
    await svc.tick();
    await svc.tick();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["read_a", "read_b"]);
    // Unattended calls are always restricted to read-only tools at the tools layer.
    expect(execute.mock.calls.every((c) => c[5].readOnlyOnly === true)).toBe(
      true,
    );
    expect(svc.get(task.id)).toMatchObject({ status: "completed", runs: 1 });
    expect(emitted.at(-1)?.payload).toMatchObject({
      title: "Taak klaar: Ochtendcheck",
      key: "autonomy",
    });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(audit.record.mock.calls.map((c) => c[0].phase)).toEqual(
      expect.arrayContaining([
        "created",
        "run_started",
        "step_done",
        "run_completed",
      ]),
    );
  });

  it("repeats every interval until maxRuns and does not catch up missed slots", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Poll",
      everySeconds: 60,
      maxRuns: 2,
      notifyOnDone: false,
      steps: [{ tool: "read_a" }],
    });
    clock += 60_000;
    await svc.tick();
    await svc.tick();
    expect(svc.get(task.id)).toMatchObject({ status: "scheduled", runs: 1 });
    clock += 10 * 60_000; // long outage: exactly one more run, not ten
    await svc.tick();
    await svc.tick();
    expect(svc.get(task.id)).toMatchObject({ status: "completed", runs: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("event-triggered workflow", () => {
  it("starts on a Node-RED trigger, dedupes by event id, honours cooldown and coalesces", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Deur open",
      event: "door.open",
      cooldownSeconds: 30,
      notifyOnDone: false,
      steps: [{ tool: "read_a" }],
    });
    expect(svc.fireEvent("door.open", "e1")).toMatchObject({
      matched: 1,
      started: 1,
    });
    expect(svc.fireEvent("door.open", "e1")).toMatchObject({
      ignored: 1,
      started: 0,
    });
    expect(svc.fireEvent("other")).toMatchObject({ matched: 0 });
    await svc.tick();
    await svc.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(svc.fireEvent("door.open", "e2")).toMatchObject({ ignored: 1 }); // cooldown
    clock += 31_000;
    expect(svc.fireEvent("door.open", "e3")).toMatchObject({ started: 1 });
    expect(svc.fireEvent("door.open", "e4")).toMatchObject({
      started: 0,
      ignored: 1,
    }); // already pending
    await svc.tick();
    await svc.tick();
    expect(svc.get(task.id)).toMatchObject({ status: "scheduled", runs: 2 });
  });

  it("accepts triggers over the token-guarded controller only", () => {
    const svc = boot();
    svc.create({ title: "E", event: "x1", steps: [{ tool: "read_a" }] });
    const token = "t".repeat(40);
    const controller = new AutonomyController(svc, {
      nodeRedEventToken: token,
    } as NovaConfig);
    expect(() => controller.trigger(undefined, { event: "x1" })).toThrow();
    expect(() => controller.trigger("Bearer wrong", { event: "x1" })).toThrow();
    expect(
      controller.trigger(`Bearer ${token}`, { event: "x1", eventId: "a" }),
    ).toMatchObject({ started: 1 });
    expect(() =>
      controller.trigger(`Bearer ${token}`, { event: "bad event!" }),
    ).toThrow();
  });
});

describe("restart recovery", () => {
  it("resumes a legacy approval wait without asking for approval again", async () => {
    const service = boot();
    const { task } = service.create({
      title: "Legacy",
      steps: [{ tool: "do_confirm" }],
    });
    handler = () => new Promise(() => undefined);
    void service.tick();
    await Promise.resolve();
    const persisted = JSON.parse(fs.readFileSync(file(), "utf8"));
    persisted.tasks[0].run.steps.s1.status = "waiting_approval";
    persisted.tasks[0].run.steps.s1.approval = { requestedAt: clock };
    fs.writeFileSync(file(), JSON.stringify(persisted));
    execute.mockClear();
    handler = async () => ({ ok: true, result: "done" });
    const restarted = boot();
    expect(restarted.get(task.id)!.run!.steps.s1?.status).toBe("pending");
    await restarted.tick();
    expect(execute).toHaveBeenCalledOnce();
    expect(restarted.get(task.id)!.status).toBe("completed");
  });

  it("does not duplicate an interrupted write now that approvals are removed", async () => {
    const service = boot();
    const { task } = service.create({
      title: "Write",
      steps: [{ tool: "do_safe" }],
    });
    handler = () => new Promise(() => undefined);
    void service.tick();
    await Promise.resolve();
    execute.mockClear();
    handler = async () => ({ ok: true, result: "done" });
    const restarted = boot();
    expect(restarted.get(task.id)!.run!.steps.s1?.status).toBe("failed");
    await restarted.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(restarted.get(task.id)!.status).toBe("failed");
  });

  it("resumes a read-only step interrupted by a crash and keeps progress", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "R",
      notifyOnDone: false,
      steps: [{ tool: "read_a" }, { tool: "read_b" }],
    });
    handler = () => new Promise(() => undefined); // the process dies mid-call
    void svc.tick();
    await Promise.resolve();
    expect(
      JSON.parse(fs.readFileSync(file(), "utf8")).tasks[0].run.steps.s1.status,
    ).toBe("running");
    execute.mockClear();
    handler = async () => ({ ok: true, result: "ok" });
    const restarted = boot();
    await restarted.tick();
    await restarted.tick();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["read_a", "read_b"]);
    expect(restarted.get(task.id)).toMatchObject({ status: "completed" });
    expect(restarted.get(task.id)!.runs).toBe(1);
  });
});

describe("retry, backoff and idempotency", () => {
  it("retries a transient read failure with doubling backoff, then succeeds", async () => {
    const svc = boot();
    let calls = 0;
    handler = async () =>
      ++calls < 3
        ? { ok: false, error: "timeout" }
        : { ok: true, result: "ok" };
    const { task } = svc.create({
      title: "B",
      notifyOnDone: false,
      steps: [{ tool: "read_a", maxAttempts: 3 }],
    });
    await svc.tick();
    await svc.tick();
    expect(calls).toBe(1);
    clock += 29_000;
    await svc.tick();
    expect(calls).toBe(1); // still backing off
    clock += 1_000;
    await svc.tick();
    expect(calls).toBe(2);
    clock += 59_000;
    await svc.tick();
    expect(calls).toBe(2);
    clock += 1_000;
    await svc.tick();
    await svc.tick();
    expect(calls).toBe(3);
    expect(svc.get(task.id)).toMatchObject({ status: "completed" });
  });

  it("fails after maxAttempts, does not retry invalid arguments or side-effect steps", async () => {
    const svc = boot();
    handler = async () => ({ ok: false, error: "Invalid tool arguments" });
    const a = svc.create({
      title: "A",
      steps: [{ tool: "read_a", maxAttempts: 5 }],
    }).task;
    await svc.tick();
    await svc.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(svc.get(a.id)?.status).toBe("failed");
    expect(emitted.at(-1)?.payload).toMatchObject({ severity: "warning" });
  });

  it("does not create the same active task twice", () => {
    const svc = boot();
    const input = {
      title: "Eén",
      delaySeconds: 60,
      steps: [{ tool: "read_a" }],
    };
    const first = svc.create(input);
    const second = svc.create(input);
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(svc.list()).toHaveLength(1);
  });

  it("does not start a second run while one is active and limits concurrency", async () => {
    const svc = boot();
    for (let i = 0; i < 4; i++)
      svc.create({ title: `T${i}`, steps: [{ tool: "read_a", args: { i } }] });
    let active = 0;
    let peak = 0;
    handler = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true, result: "ok" };
    };
    clock += 1;
    for (let i = 0; i < 6; i++) await svc.tick();
    expect(peak).toBeLessThanOrEqual(2);
    expect(svc.list().filter((t) => t.status === "completed")).toHaveLength(4);
  });
});

describe("budgets, dependencies and follow-up", () => {
  it("stops a run when the tool-call budget is exhausted", async () => {
    const svc = boot();
    handler = async () => ({ ok: true, result: "nog niet" });
    const { task } = svc.create({
      title: "Budget",
      maxToolCalls: 3,
      steps: [{ tool: "read_a", untilContains: "ja", pollEverySeconds: 30 }],
    });
    clock += 1;
    for (let i = 0; i < 8; i++) {
      await svc.tick();
      clock += 31_000;
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(svc.get(task.id)).toMatchObject({ status: "failed" });
    expect(svc.get(task.id)!.lastRun!.summary).toMatch(/budget/);
  });

  it("stops a run that exceeds its time budget", async () => {
    const svc = boot();
    handler = async () => ({ ok: true, result: "nee" });
    const { task } = svc.create({
      title: "Tijd",
      maxRunMinutes: 1,
      steps: [{ tool: "read_a", untilContains: "ja", pollEverySeconds: 30 }],
    });
    clock += 1;
    await svc.tick();
    clock += 120_000;
    await svc.tick();
    expect(svc.get(task.id)).toMatchObject({ status: "failed" });
  });

  it("watches until the condition holds, then tells the user once", async () => {
    const svc = boot();
    let n = 0;
    handler = async () => ({
      ok: true,
      result: ++n < 3 ? "status: bezig" : "status: gereed",
    });
    const { task } = svc.create({
      title: "Download",
      steps: [
        { tool: "read_a", untilContains: "gereed", pollEverySeconds: 30 },
      ],
    });
    clock += 1;
    for (let i = 0; i < 4; i++) {
      await svc.tick();
      clock += 31_000;
    }
    expect(n).toBe(3);
    expect(svc.get(task.id)).toMatchObject({ status: "completed" });
    const notices = emitted.filter((e) =>
      String(e.payload.title).startsWith("Gemeld"),
    );
    expect(notices).toHaveLength(1);
  });

  it("skips dependents of a failed step but still runs independent steps", async () => {
    const svc = boot();
    handler = async (name) =>
      name === "read_a"
        ? { ok: false, error: "Invalid tool arguments" }
        : { ok: true, result: "ok" };
    const { task } = svc.create({
      title: "Deps",
      steps: [
        { id: "a", tool: "read_a" },
        { id: "b", tool: "read_b", dependsOn: ["a"] },
        { id: "c", tool: "read_b", args: { x: 1 }, dependsOn: [] },
      ],
    });
    clock += 1;
    for (let i = 0; i < 4; i++) await svc.tick();
    const done = svc.get(task.id)!;
    expect(done.status).toBe("failed");
    expect(execute.mock.calls.filter((c) => c[0] === "read_b")).toHaveLength(1);
  });
});
