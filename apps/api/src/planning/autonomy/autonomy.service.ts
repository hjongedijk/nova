import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { PendingConfirmation } from "@nova/contracts";
import crypto from "node:crypto";
import { requiresScreenConfirmation } from "../../confirmations/screen-confirmation.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { sanitize } from "../../core/security/sanitize.js";
import { ToolsService } from "../../tools/tools.service.js";
import { JarvisStateStore } from "../jarvis-state.store.js";
import { AutonomyStore } from "./autonomy.store.js";
import {
  AutonomyError,
  LIMITS,
  type AutoStep,
  type AutoTask,
  type StepState,
  type TaskTrigger,
} from "./autonomy.types.js";

export interface CreateTaskInput {
  title: string;
  steps: Array<{
    id?: string;
    tool: string;
    args?: Record<string, unknown>;
    dependsOn?: string[];
    maxAttempts?: number;
    untilContains?: string;
    pollEverySeconds?: number;
  }>;
  runAt?: string;
  delaySeconds?: number;
  everySeconds?: number;
  event?: string;
  cooldownSeconds?: number;
  maxRuns?: number;
  maxToolCalls?: number;
  maxRunMinutes?: number;
  expiresInDays?: number;
  autoSafe?: boolean;
  notifyOnDone?: boolean;
}

const EVENT_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const STEP_ID = /^[a-z0-9_-]{1,24}$/i;
const TERMINAL = new Set(["done", "failed", "skipped"]);
const PERMANENT = /^(?:Unknown tool|Invalid tool arguments)/;
const short = (value: unknown, max = 300): string =>
  String(sanitize(typeof value === "string" ? value : JSON.stringify(value)))
    .replace(/\s+/g, " ")
    .slice(0, max);

/**
 * The durable autonomous task runner. State is persisted before and after every step, so a
 * restart resumes where it stopped: read-only steps are repeated, approved side-effect steps are
 * never repeated automatically. Risky steps pause for an approval that arrives through the
 * existing confirmation path; nothing DANGEROUS ever runs unattended.
 */
@Injectable()
export class AutonomyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("NOVA autonomy");
  private tasksList: AutoTask[] = [];
  private pump?: NodeJS.Timeout;
  private readonly inflight = new Set<string>();
  /** Replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly store: AutonomyStore,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
    private readonly events: JarvisStateStore,
  ) {}

  onModuleInit(): void {
    this.recover();
    if (process.env.NODE_ENV === "test") return;
    this.pump = setInterval(
      () => void this.tick().catch(() => undefined),
      5000,
    );
    this.pump.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pump);
  }

  /** Load the file and make interrupted work safe to continue. */
  recover(): void {
    this.tasksList = this.store.load();
    const now = this.now();
    for (const task of this.tasksList) {
      if (task.status !== "running" || !task.run) continue;
      for (const step of task.steps) {
        const state = task.run.steps[step.id];
        if (state?.status !== "running") continue;
        if (state.approval?.grantedAt) {
          state.status = "failed";
          state.error =
            "Onderbroken tijdens uitvoering; niet automatisch herhaald.";
          state.finishedAt = now;
          this.record(task, "interrupted_not_repeated", { step: step.id });
          this.notify(
            task,
            "warning",
            `Taak onderbroken: ${task.title}`,
            `Stap ${step.tool} was bezig bij een herstart en wordt niet automatisch herhaald.`,
          );
        } else {
          state.status = "retry";
          state.nextAt = now;
          this.record(task, "resumed_after_restart", { step: step.id });
        }
      }
    }
    this.trySave();
  }

  list(): AutoTask[] {
    return structuredClone(this.tasksList);
  }

  get(id: string): AutoTask | undefined {
    const task = this.tasksList.find((item) => item.id === id);
    return task && structuredClone(task);
  }

  create(
    input: CreateTaskInput,
    now = this.now(),
  ): { task: AutoTask; duplicate: boolean } {
    const title = String(input.title ?? "")
      .trim()
      .slice(0, 80);
    if (!title) throw new AutonomyError("Geef de taak een korte titel.");
    if (!Array.isArray(input.steps) || !input.steps.length)
      throw new AutonomyError("Een taak heeft minstens één stap nodig.");
    if (input.steps.length > LIMITS.maxSteps)
      throw new AutonomyError(
        `Een taak mag maximaal ${LIMITS.maxSteps} stappen hebben.`,
      );
    const catalog = new Map(this.tools.list().map((tool) => [tool.name, tool]));
    const steps: AutoStep[] = [];
    input.steps.forEach((raw, index) => {
      const id = raw.id ?? `s${index + 1}`;
      if (!STEP_ID.test(id) || steps.some((step) => step.id === id))
        throw new AutonomyError("Ongeldige of dubbele stap-id.");
      const info = catalog.get(raw.tool);
      if (!info?.enabled || raw.tool.startsWith("autonomy_"))
        throw new AutonomyError(
          `Tool ${raw.tool} is niet beschikbaar voor taken.`,
        );
      const args = raw.args ?? {};
      if (
        info.risk === "DANGEROUS" ||
        requiresScreenConfirmation(raw.tool, args, info.risk)
      )
        throw new AutonomyError(
          `Tool ${raw.tool} is te riskant voor een taak zonder jou.`,
        );
      const json = JSON.stringify(args);
      if (json.length > LIMITS.maxArgsChars)
        throw new AutonomyError("De argumenten van een stap zijn te groot.");
      if (JSON.stringify(sanitize(args)) !== json)
        throw new AutonomyError("Zet geen geheimen in taakargumenten.");
      const dependsOn = raw.dependsOn ?? (index ? [steps[index - 1]!.id] : []);
      for (const dep of dependsOn)
        if (!steps.some((step) => step.id === dep))
          throw new AutonomyError(
            "Een stap kan alleen van eerdere stappen afhangen.",
          );
      const until = raw.untilContains?.trim();
      if (until && info.risk !== "READ_ONLY")
        throw new AutonomyError(
          "Alleen leesstappen kunnen herhaald worden tot een voorwaarde klopt.",
        );
      steps.push({
        id,
        tool: raw.tool,
        args: structuredClone(args),
        dependsOn,
        maxAttempts: Math.min(5, Math.max(1, Math.round(raw.maxAttempts ?? 3))),
        ...(until
          ? {
              until: {
                contains: until.slice(0, 120),
                pollEveryMs: Math.max(
                  LIMITS.minPollMs,
                  Math.round((raw.pollEverySeconds ?? 60) * 1000),
                ),
              },
            }
          : {}),
      });
    });

    const trigger = this.buildTrigger(input, now);
    const defaultRuns =
      trigger.kind === "at" ? 1 : trigger.kind === "every" ? 24 : 100;
    const maxRuns =
      trigger.kind === "at"
        ? 1
        : Math.min(
            LIMITS.maxRunsCap,
            Math.max(1, Math.round(input.maxRuns ?? defaultRuns)),
          );
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify([title, trigger, steps, input.autoSafe === true]))
      .digest("hex")
      .slice(0, 24);
    const live = this.tasksList.find(
      (task) =>
        task.fingerprint === fingerprint &&
        (task.status === "scheduled" || task.status === "running"),
    );
    if (live) return { task: structuredClone(live), duplicate: true };
    if (
      this.tasksList.filter(
        (t) => t.status === "scheduled" || t.status === "running",
      ).length >= LIMITS.maxActive
    )
      throw new AutonomyError(
        "Er lopen al te veel taken; annuleer er eerst een.",
      );
    const task: AutoTask = {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      createdAt: now,
      updatedAt: now,
      status: "scheduled",
      trigger,
      steps,
      autoSafe: input.autoSafe === true,
      notifyOnDone: input.notifyOnDone !== false,
      budget: {
        maxToolCalls: Math.min(
          LIMITS.maxToolCallsCap,
          Math.max(
            1,
            Math.round(input.maxToolCalls ?? LIMITS.defaultToolCalls),
          ),
        ),
        maxRunMs: Math.min(
          LIMITS.maxRunMsCap,
          Math.max(60_000, Math.round((input.maxRunMinutes ?? 60) * 60_000)),
        ),
        maxRuns,
        expiresAt:
          now +
          Math.min(
            LIMITS.maxExpiryMs,
            Math.max(
              86_400_000,
              Math.round((input.expiresInDays ?? 30) * 86_400_000),
            ),
          ),
      },
      fingerprint,
      runs: 0,
      consecutiveFailures: 0,
      nextRunAt:
        trigger.kind === "at"
          ? trigger.at
          : trigger.kind === "every"
            ? now +
              Math.max(
                0,
                Math.round((input.delaySeconds ?? 0) * 1000) || trigger.everyMs,
              )
            : null,
      seenEvents: [],
      run: null,
    };
    this.tasksList.push(task);
    this.prune();
    this.save();
    this.record(task, "created", {
      trigger: trigger.kind,
      steps: steps.map((s) => s.tool),
    });
    return { task: structuredClone(task), duplicate: false };
  }

  private buildTrigger(input: CreateTaskInput, now: number): TaskTrigger {
    const chosen = [input.runAt, input.everySeconds, input.event].filter(
      (v) => v !== undefined,
    ).length;
    if (chosen > 1)
      throw new AutonomyError(
        "Kies één trigger: runAt, everySeconds of event.",
      );
    if (input.event !== undefined) {
      if (!EVENT_NAME.test(input.event))
        throw new AutonomyError("Ongeldige eventnaam.");
      return {
        kind: "event",
        name: input.event.toLowerCase(),
        cooldownMs: Math.max(
          LIMITS.minCooldownMs,
          Math.round((input.cooldownSeconds ?? 60) * 1000),
        ),
      };
    }
    if (input.everySeconds !== undefined) {
      const everyMs = Math.round(input.everySeconds * 1000);
      if (!(everyMs >= LIMITS.minEveryMs))
        throw new AutonomyError("Herhaling kan niet vaker dan elke minuut.");
      return { kind: "every", everyMs };
    }
    if (input.runAt !== undefined) {
      if (
        !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.runAt) ||
        Number.isNaN(Date.parse(input.runAt))
      )
        throw new AutonomyError("Gebruik een ISO-tijd met tijdzone.");
      const at = Date.parse(input.runAt);
      if (at < now - 60_000)
        throw new AutonomyError("Die tijd ligt al in het verleden.");
      return { kind: "at", at };
    }
    return {
      kind: "at",
      at: now + Math.max(0, Math.round((input.delaySeconds ?? 0) * 1000)),
    };
  }

  cancel(id: string, now = this.now()): boolean {
    const task = this.tasksList.find((item) => item.id === id);
    if (
      !task ||
      task.status === "cancelled" ||
      task.status === "completed" ||
      task.status === "failed"
    )
      return false;
    task.status = "cancelled";
    task.nextRunAt = null;
    task.pendingTrigger = false;
    task.updatedAt = now;
    if (task.run)
      for (const state of Object.values(task.run.steps))
        if (!TERMINAL.has(state.status) && state.status !== "running")
          state.status = "skipped";
    this.record(task, "cancelled", {});
    this.save();
    return true;
  }

  /** The user said yes to a waiting step. Returns the approved step ids. */
  approve(id: string, now = this.now()): string[] {
    const task = this.tasksList.find((item) => item.id === id);
    if (!task?.run) return [];
    const approved: string[] = [];
    for (const step of task.steps) {
      const state = task.run.steps[step.id];
      if (state?.status !== "waiting_approval" || !state.approval) continue;
      if (now - state.approval.requestedAt > LIMITS.approvalTtlMs) continue;
      state.approval.grantedAt = now;
      state.status = "pending";
      approved.push(step.id);
      this.record(task, "approval_granted", {
        step: step.id,
        tool: step.tool,
        confirmation: "approved",
      });
    }
    if (approved.length) this.save();
    return approved;
  }

  /** An event from Node-RED (MQTT, Home Assistant, ...). */
  fireEvent(
    name: string,
    eventId?: string,
    now = this.now(),
  ): { matched: number; started: number; ignored: number } {
    const result = { matched: 0, started: 0, ignored: 0 };
    const key = name.toLowerCase();
    for (const task of this.tasksList) {
      if (task.trigger.kind !== "event" || task.trigger.name !== key) continue;
      if (task.status !== "scheduled" && task.status !== "running") continue;
      result.matched++;
      if (eventId && task.seenEvents.includes(eventId)) {
        result.ignored++;
        continue;
      }
      if (
        task.lastTriggerAt !== undefined &&
        now - task.lastTriggerAt < task.trigger.cooldownMs
      ) {
        result.ignored++;
        continue;
      }
      if (eventId) task.seenEvents = [...task.seenEvents, eventId].slice(-50);
      task.lastTriggerAt = now;
      if (task.pendingTrigger) {
        result.ignored++;
        continue;
      }
      task.pendingTrigger = true;
      result.started++;
      this.record(task, "event_trigger", { event: key });
    }
    if (result.started) this.save();
    return result;
  }

  /** One scheduling pass; resolves when the steps it started have finished. */
  async tick(now = this.now()): Promise<void> {
    this.startDueRuns(now);
    const started: Promise<void>[] = [];
    for (const task of this.tasksList) {
      if (task.status !== "running" || this.inflight.has(task.id)) continue;
      if (this.inflight.size >= LIMITS.maxConcurrentSteps) break;
      const work = this.advance(task, now);
      if (work) {
        this.inflight.add(task.id);
        started.push(work.finally(() => this.inflight.delete(task.id)));
      }
    }
    await Promise.all(started);
  }

  private startDueRuns(now: number): void {
    let running = this.tasksList.filter((t) => t.status === "running").length;
    let changed = false;
    for (const task of this.tasksList) {
      if (task.status !== "scheduled") continue;
      if (now >= task.budget.expiresAt) {
        task.status = "completed";
        task.note = "Verlopen.";
        task.nextRunAt = null;
        this.record(task, "expired", {});
        changed = true;
        continue;
      }
      const due =
        task.pendingTrigger ||
        (task.nextRunAt !== null && task.nextRunAt <= now);
      if (!due || running >= LIMITS.maxConcurrentRuns) continue;
      running++;
      changed = true;
      task.pendingTrigger = false;
      task.status = "running";
      task.updatedAt = now;
      task.run = {
        id: crypto.randomBytes(4).toString("hex"),
        startedAt: now,
        toolCalls: 0,
        steps: Object.fromEntries(
          task.steps.map((step): [string, StepState] => [
            step.id,
            { status: "pending", attempts: 0 },
          ]),
        ),
      };
      this.record(task, "run_started", { run: task.run.id });
    }
    if (changed) this.trySave();
  }

  /** Decide the next move of a running task; returns the work when a tool call must be awaited. */
  private advance(task: AutoTask, now: number): Promise<void> | null {
    const run = task.run;
    if (!run) return null;
    const states = run.steps;
    if (now - run.startedAt > task.budget.maxRunMs) {
      this.failRun(task, now, "Tijdbudget van de taak is op.");
      return null;
    }
    if (this.settle(task, now)) return null;
    for (const step of task.steps) {
      const state = states[step.id]!;
      if (state.status === "waiting_approval") {
        if (
          state.approval &&
          now - state.approval.requestedAt > LIMITS.approvalTtlMs
        ) {
          state.status = "failed";
          state.error = "Goedkeuring is verlopen.";
          this.record(task, "approval_expired", { step: step.id });
          this.save();
          return null;
        }
        continue;
      }
      const ready =
        (state.status === "pending" ||
          (state.status === "retry" && (state.nextAt ?? 0) <= now)) &&
        step.dependsOn.every((dep) => states[dep]?.status === "done");
      if (!ready) continue;
      return this.runStep(task, step, state, now);
    }
    return null;
  }

  /** Skip what depends on a failed step and finish the run when every step is final. */
  private settle(task: AutoTask, now: number): boolean {
    const states = task.run!.steps;
    for (let changed = true; changed;) {
      changed = false;
      for (const step of task.steps) {
        const state = states[step.id]!;
        if (state.status !== "pending" && state.status !== "retry") continue;
        if (
          step.dependsOn.some(
            (dep) =>
              states[dep]?.status === "failed" ||
              states[dep]?.status === "skipped",
          )
        ) {
          state.status = "skipped";
          changed = true;
        }
      }
    }
    if (!task.steps.every((step) => TERMINAL.has(states[step.id]!.status)))
      return false;
    const failed = task.steps.find(
      (step) => states[step.id]!.status === "failed",
    );
    const last = [...task.steps]
      .reverse()
      .map((s) => states[s.id]!)
      .find((s) => s.summary);
    if (failed)
      this.finishRun(
        task,
        now,
        false,
        states[failed.id]!.error ?? "Stap mislukt.",
      );
    else this.finishRun(task, now, true, last?.summary ?? "Klaar.");
    return true;
  }

  private runStep(
    task: AutoTask,
    step: AutoStep,
    state: StepState,
    now: number,
  ): Promise<void> | null {
    const run = task.run!;
    const fail = (error: string): null => {
      state.status = "failed";
      state.error = error;
      state.finishedAt = now;
      this.record(task, "step_failed", {
        step: step.id,
        tool: step.tool,
        error,
      });
      this.trySave();
      return null;
    };
    if (run.toolCalls >= task.budget.maxToolCalls) {
      this.failRun(task, now, "Stapbudget van de taak is op.");
      return null;
    }
    const info = this.tools.list().find((tool) => tool.name === step.tool);
    if (!info?.enabled) return fail("Tool niet beschikbaar.");
    if (
      info.risk === "DANGEROUS" ||
      requiresScreenConfirmation(step.tool, step.args, info.risk)
    )
      return fail("Gevaarlijke stappen draaien nooit zonder jou.");
    const readOnly = info.risk === "READ_ONLY";
    const needsApproval =
      !readOnly && (info.risk === "CONFIRM" || !task.autoSafe);
    if (needsApproval && !state.approval?.grantedAt)
      return (this.requestApproval(task, step, state, now), null);
    state.status = "running";
    state.attempts++;
    state.startedAt = now;
    run.toolCalls++;
    try {
      this.store.save(this.tasksList); // fail closed: no step runs when the marker is not durable
    } catch {
      return fail("Taakstatus kon niet worden opgeslagen.");
    }
    this.record(task, "step_started", {
      step: step.id,
      tool: step.tool,
      attempt: state.attempts,
      risk: info.risk,
    });
    return this.execute(task, step, state, readOnly, info.risk);
  }

  private requestApproval(
    task: AutoTask,
    step: AutoStep,
    state: StepState,
    now: number,
  ): void {
    state.status = "waiting_approval";
    state.approval = { requestedAt: now };
    task.updatedAt = now;
    this.record(task, "approval_requested", {
      step: step.id,
      tool: step.tool,
      confirmation: "pending",
    });
    this.trySave();
    this.notify(
      task,
      "warning",
      `Goedkeuring nodig: ${task.title}`,
      `Stap ${step.tool} ${short(step.args, 100)} wacht op je ok. Zeg: keur taak ${task.id} goed.`,
    );
  }

  private async execute(
    task: AutoTask,
    step: AutoStep,
    state: StepState,
    readOnly: boolean,
    risk: "READ_ONLY" | "SAFE" | "CONFIRM" | "DANGEROUS",
  ): Promise<void> {
    const sessionId = `autonomy_${task.id}`;
    const stamp = (action: Partial<PendingConfirmation>): PendingConfirmation =>
      ({
        confirmationId: crypto.randomUUID(),
        sessionId,
        tool: step.tool,
        args: step.args,
        risk,
        createdAt: Date.now(),
        ...action,
        expiresAt: Date.now() + 60_000,
      }) as PendingConfirmation;
    let outcome: {
      ok: boolean;
      error?: string;
      summary?: string;
      waiting?: boolean;
      text?: string;
    };
    try {
      const approved = state.approval?.grantedAt ? stamp({}) : null;
      const signal = AbortSignal.timeout(60_000);
      let result = await this.tools.execute(
        step.tool,
        step.args,
        sessionId,
        approved,
        false,
        { signal, readOnlyOnly: readOnly },
      );
      if (approved && result.requiresConfirmation && result.action) {
        if (result.action.tool === step.tool && result.action.risk === risk) {
          // Only argument coercion differed from what the user approved.
          result = await this.tools.execute(
            step.tool,
            step.args,
            sessionId,
            stamp(result.action),
            false,
            { signal, readOnlyOnly: readOnly },
          );
        } else {
          result = {
            ok: false,
            error: "Het risico van de stap is gewijzigd; opnieuw plannen.",
          };
        }
      }
      if (result.requiresConfirmation && !approved)
        outcome = { ok: false, waiting: true };
      else if (result.requiresConfirmation)
        outcome = { ok: false, error: "Goedkeuring werd niet geaccepteerd." };
      else {
        const payload = short(
          result.ok ? (result.result ?? result) : (result.error ?? "mislukt"),
        );
        outcome = {
          ok: result.ok === true,
          error: result.ok ? undefined : payload,
          summary: payload,
          text: payload.toLowerCase(),
        };
      }
    } catch {
      outcome = { ok: false, error: "Tool onbereikbaar of time-out." };
    }
    const now = this.now();
    if (task.status === "cancelled") return;
    if (outcome.waiting) {
      state.status = "pending";
      this.requestApproval(task, step, state, now);
      return;
    }
    if (outcome.ok) {
      if (
        step.until &&
        !outcome.text!.includes(step.until.contains.toLowerCase())
      ) {
        state.status = "retry";
        state.nextAt = now + step.until.pollEveryMs;
        state.summary = outcome.summary;
        this.record(task, "watch_polled", { step: step.id, met: false });
      } else {
        state.status = "done";
        state.finishedAt = now;
        state.summary = outcome.summary;
        this.record(task, "step_done", {
          step: step.id,
          tool: step.tool,
          verification: true,
        });
        if (step.until)
          this.notify(
            task,
            "info",
            `Gemeld: ${task.title}`,
            `Voorwaarde "${step.until.contains}" is bereikt. ${outcome.summary}`.slice(
              0,
              240,
            ),
          );
      }
    } else if (
      readOnly &&
      state.attempts < step.maxAttempts &&
      !PERMANENT.test(outcome.error ?? "")
    ) {
      state.status = "retry";
      state.nextAt =
        now +
        Math.min(
          LIMITS.backoffMaxMs,
          LIMITS.backoffBaseMs * 2 ** (state.attempts - 1),
        );
      state.error = outcome.error;
      this.record(task, "step_retry", {
        step: step.id,
        attempt: state.attempts,
        nextAt: state.nextAt,
      });
    } else {
      state.status = "failed";
      state.error = outcome.error;
      state.finishedAt = now;
      this.record(task, "step_failed", {
        step: step.id,
        tool: step.tool,
        error: outcome.error,
      });
    }
    this.trySave();
    if (task.run) this.settle(task, now);
  }

  private failRun(task: AutoTask, now: number, reason: string): void {
    for (const state of Object.values(task.run?.steps ?? {}))
      if (!TERMINAL.has(state.status)) {
        state.status = "skipped";
        state.error = reason;
      }
    this.finishRun(task, now, false, reason);
  }

  private finishRun(
    task: AutoTask,
    now: number,
    ok: boolean,
    summary: string,
  ): void {
    task.runs++;
    task.consecutiveFailures = ok ? 0 : task.consecutiveFailures + 1;
    task.lastRun = { at: now, outcome: ok ? "ok" : "failed", summary };
    task.run = null;
    task.updatedAt = now;
    let final = task.runs >= task.budget.maxRuns || task.trigger.kind === "at";
    if (!ok && task.consecutiveFailures >= LIMITS.maxConsecutiveFailures)
      final = true;
    if (final) {
      task.status =
        ok ||
        (task.trigger.kind !== "at" &&
          task.consecutiveFailures < LIMITS.maxConsecutiveFailures)
          ? "completed"
          : "failed";
      task.nextRunAt = null;
    } else {
      task.status = "scheduled";
      if (task.trigger.kind === "every") {
        let next = (task.nextRunAt ?? now) + task.trigger.everyMs;
        if (next <= now)
          next +=
            Math.ceil((now - next + 1) / task.trigger.everyMs) *
            task.trigger.everyMs;
        task.nextRunAt = next;
      }
    }
    this.record(task, ok ? "run_completed" : "run_failed", { summary });
    this.trySave();
    if (!ok)
      this.notify(task, "warning", `Taak mislukt: ${task.title}`, summary);
    else if (task.notifyOnDone && task.steps.every((s) => !s.until))
      this.notify(task, "info", `Taak klaar: ${task.title}`, summary);
  }

  private notify(
    task: AutoTask,
    severity: "info" | "warning",
    title: string,
    detail: string,
  ): void {
    try {
      this.events.emit({
        topic: "jarvis/alerts",
        payload: {
          title: title.slice(0, 120),
          detail: detail.slice(0, 240),
          severity,
          key: "autonomy",
          at: new Date(this.now()).toISOString(),
        },
      });
    } catch {
      this.log.warn(`notification for ${task.id} failed`);
    }
  }

  private record(
    task: AutoTask,
    phase: string,
    extra: Record<string, unknown>,
  ): void {
    try {
      this.audit.record({
        sessionId: `autonomy_${task.id}`,
        tool: "autonomy",
        phase,
        task: task.id,
        ...extra,
      });
    } catch {
      /* the audit log must not stop a task; tools audit themselves too */
    }
  }

  private prune(): void {
    while (this.tasksList.length > LIMITS.maxTasks) {
      const index = this.tasksList.findIndex(
        (t) => t.status !== "scheduled" && t.status !== "running",
      );
      if (index < 0)
        throw new AutonomyError("Te veel taken; annuleer er eerst een.");
      this.tasksList.splice(index, 1);
    }
  }

  private save(): void {
    this.store.save(this.tasksList);
  }

  private trySave(): void {
    try {
      this.save();
    } catch {
      /* memory stays authoritative; the next change retries */
    }
  }
}
