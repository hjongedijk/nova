import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutonomyController } from "../../src/planning/autonomy/autonomy.controller.js";
import { AutonomyService } from "../../src/planning/autonomy/autonomy.service.js";
import { AutonomySource } from "../../src/planning/autonomy/autonomy.source.js";
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

  it("never repeats an approved side-effect step that was in flight at the crash", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "W",
      steps: [{ tool: "do_confirm" }],
    });
    clock += 1;
    await svc.tick(); // run starts, step waits for approval
    svc.approve(task.id);
    handler = () => new Promise(() => undefined);
    void svc.tick();
    await Promise.resolve();
    execute.mockClear();
    const restarted = boot();
    await restarted.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(restarted.get(task.id)).toMatchObject({ status: "failed" });
    expect(emitted.at(-1)?.payload.title).toMatch(/onderbroken|mislukt/);
  });

  it("keeps a waiting approval across a restart", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "W",
      steps: [{ tool: "do_confirm" }],
    });
    clock += 1;
    await svc.tick();
    const restarted = boot();
    await restarted.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(restarted.approve(task.id)).toEqual(["s1"]);
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

describe("permission boundary", () => {
  it("refuses DANGEROUS tools, secrets and nested autonomy at creation", () => {
    const svc = boot();
    expect(() =>
      svc.create({ title: "x", steps: [{ tool: "do_danger" }] }),
    ).toThrow(/riskant/);
    expect(() =>
      svc.create({
        title: "x",
        steps: [{ tool: "read_a", args: { api_key: "abc" } }],
      }),
    ).toThrow(/geheimen/);
    expect(() =>
      svc.create({ title: "x", steps: [{ tool: "autonomy_create" }] }),
    ).toThrow();
    expect(() =>
      svc.create({ title: "x", steps: [{ tool: "nope" }] }),
    ).toThrow();
  });

  it("pauses a CONFIRM step, notifies, and runs it only after approval", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Lamp",
      steps: [{ tool: "read_a" }, { tool: "do_confirm", args: { on: true } }],
      notifyOnDone: false,
    });
    clock += 1;
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["read_a"]);
    expect(emitted.at(-1)?.payload).toMatchObject({
      severity: "warning",
      title: "Goedkeuring nodig: Lamp",
    });
    expect(svc.get(task.id)!.run!.steps.s2!.status).toBe("waiting_approval");
    // Nothing happens however long it waits (no auto-approve), until the user approves.
    clock += 3_600_000;
    await svc.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(svc.approve(task.id)).toEqual(["s2"]);
    await svc.tick();
    await svc.tick();
    const call = execute.mock.calls.at(-1)!;
    expect(call[0]).toBe("do_confirm");
    expect(call[3]).toMatchObject({
      tool: "do_confirm",
      args: { on: true },
      risk: "CONFIRM",
    });
    expect(call[5].readOnlyOnly).toBe(false);
    expect(svc.get(task.id)).toMatchObject({ status: "completed" });
  });

  it("lets an expired approval fail instead of running late", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Oud",
      steps: [{ tool: "do_confirm" }],
    });
    clock += 1;
    await svc.tick();
    clock += 25 * 3_600_000;
    expect(svc.approve(task.id)).toEqual([]);
    await svc.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(svc.get(task.id)?.status).toBe("failed");
  });

  it("treats SAFE steps as approval-required unless autoSafe, and honours a tool-side confirmation", async () => {
    const svc = boot();
    const a = svc.create({ title: "S1", steps: [{ tool: "do_safe" }] }).task;
    clock += 1;
    await svc.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(svc.get(a.id)!.run!.steps.s1!.status).toBe("waiting_approval");
    // autoSafe: still bound by the global auto-execute switch (tool answers requiresConfirmation).
    const b = svc.create({
      title: "S2",
      autoSafe: true,
      steps: [{ tool: "do_safe", args: { z: 1 } }],
    }).task;
    handler = async () => ({
      ok: false,
      requiresConfirmation: true,
      action: { tool: "do_safe", risk: "SAFE" },
    });
    await svc.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(svc.get(b.id)!.run!.steps.s1!.status).toBe("waiting_approval");
  });

  it("cannot be used to run a step the tool layer reports as a changed risk", async () => {
    const svc = boot();
    const { task } = svc.create({
      title: "Risk",
      steps: [{ tool: "do_confirm" }],
    });
    clock += 1;
    await svc.tick();
    svc.approve(task.id);
    handler = async () => ({
      ok: false,
      requiresConfirmation: true,
      action: { tool: "do_confirm", risk: "DANGEROUS" },
    });
    await svc.tick();
    expect(svc.get(task.id)).toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledTimes(1);
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

describe("tools", () => {
  it("create/list/cancel/approve through the tool source with Dutch errors", async () => {
    const svc = boot();
    const source = new AutonomySource(svc);
    const names = source.definitions().map((d) => d.name);
    expect(names).toEqual([
      "autonomy_create",
      "autonomy_list",
      "autonomy_cancel",
      "autonomy_approve",
    ]);
    const risks = Object.fromEntries(
      source.definitions().map((d) => [d.name, d.risk]),
    );
    expect(risks).toMatchObject({
      autonomy_create: "CONFIRM",
      autonomy_approve: "CONFIRM",
      autonomy_list: "READ_ONLY",
    });
    const created = await source.execute("autonomy_create", {
      title: "Via tool",
      delaySeconds: 60,
      steps: [{ tool: "read_a" }],
    });
    expect(created.ok).toBe(true);
    const bad = await source.execute("autonomy_create", {
      title: "x",
      steps: [{ tool: "do_danger" }],
    });
    expect(bad).toMatchObject({
      ok: false,
      error: expect.stringMatching(/riskant/),
    });
    const listed = await source.execute("autonomy_list", {});
    expect((listed.result as unknown[]).length).toBe(1);
    const id = (created.result as { task: { id: string } }).task.id;
    expect(await source.execute("autonomy_cancel", { id })).toMatchObject({
      ok: true,
    });
    expect(await source.execute("autonomy_cancel", { id })).toMatchObject({
      ok: false,
    });
  });
});
