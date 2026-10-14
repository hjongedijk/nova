"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const WINDOW_MS = 4 * 60 * 60 * 1000;
const MAX_JOBS = 32;
const MAX_ATTEMPTS = 6;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const owners = new Set();

/** One bounded durable outbox per deployed node; model calls are read-only. */
class BriefingState {
  constructor({
    file,
    nodeId,
    kind,
    time = "",
    timezone = "Europe/Amsterdam",
    ask,
    deliver,
    now = Date.now,
  }) {
    if (
      !["morning_briefing", "evening_review"].includes(kind) ||
      (time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    )
      throw new Error("Invalid briefing schedule");
    this.formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    this.file = file;
    this.kind = kind;
    this.time = time;
    this.fingerprint = hash(JSON.stringify([nodeId, kind, time, timezone]));
    this.eventIdentity = hash(JSON.stringify([nodeId, kind]));
    this.ask = ask;
    this.deliver = deliver;
    this.now = now;
    this.closed = false;
    this.running = null;
    if (owners.has(file)) throw new Error("Briefing owner already active");
    this.jobs = this.load();
    if (this.needsUpgrade) this.save();
    owners.add(file);
  }

  load() {
    let descriptor;
    try {
      descriptor = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 100000 || stat.mode & 0o077)
        throw new Error();
      const state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (
        ![1, 2].includes(state.version) ||
        !Array.isArray(state.jobs) ||
        state.jobs.length > MAX_JOBS ||
        state.jobs.some(
          (job) =>
            !job ||
            !/^nova-workflow:[a-f0-9]{64}$/.test(job.id) ||
            !/^[a-f0-9]{64}$/.test(job.fingerprint) ||
            !["pending", "reply", "complete", "failed"].includes(job.status) ||
            !Number.isInteger(job.attempts) ||
            job.attempts < 0 ||
            job.attempts > MAX_ATTEMPTS ||
            !Number.isSafeInteger(job.nextAt) ||
            !Number.isSafeInteger(job.expiresAt) ||
            !Number.isSafeInteger(job.createdAt) ||
            !["schedule", "event"].includes(job.source) ||
            (job.reply !== undefined &&
              (typeof job.reply !== "string" ||
                !job.reply.trim() ||
                job.reply.length > 240)) ||
            (job.status === "reply" && !job.reply) ||
            (state.version === 2 &&
              job.source === "event" &&
              !(
                typeof job.eventOwner === "string" &&
                /^[a-f0-9]{64}$/.test(job.eventOwner)
              ) &&
              !(job.eventOwner === undefined && job.status === "failed")),
        )
      )
        throw new Error();
      if (new Set(state.jobs.map((job) => job.id)).size !== state.jobs.length)
        throw new Error();
      this.needsUpgrade = state.version === 1;
      if (this.needsUpgrade) {
        for (const job of state.jobs) {
          if (job.source !== "event") continue;
          if (job.fingerprint === this.fingerprint)
            job.eventOwner = this.eventIdentity;
          else {
            // Legacy records contain no recoverable kind: never infer ownership.
            delete job.eventOwner;
            job.status = "failed";
          }
        }
      }
      return state.jobs;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Briefing state unavailable", { cause: error });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ version: 2, jobs: this.jobs }),
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.file);
      descriptor = fs.openSync(path.dirname(this.file), "r");
      fs.fsyncSync(descriptor);
      this.needsUpgrade = false;
    } catch {
      this.needsReload = true;
      throw new Error("Briefing state unavailable");
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  enqueue(source, key, createdAt = this.now()) {
    if (this.closed) return false;
    if (this.needsReload) {
      this.jobs = this.load();
      this.needsReload = false;
    }
    const identity = source === "event" ? this.eventIdentity : this.fingerprint;
    const id = `nova-workflow:${hash(`${identity}:${source}:${key}`)}`;
    if (
      this.jobs.some(
        (job) =>
          job.id === id ||
          (source === "event" &&
            job.source === "event" &&
            job.eventOwner === this.eventIdentity &&
            job.id ===
              `nova-workflow:${hash(`${job.fingerprint}:event:${key}`)}`),
      )
    )
      return false;
    // Retain at least seven days of deduplication, including failed jobs.
    this.jobs = this.jobs.filter(
      (job) => job.expiresAt + 7 * 86400000 > this.now(),
    );
    if (this.jobs.length >= MAX_JOBS) throw new Error("Briefing queue is full");
    const job = {
      id,
      fingerprint: this.fingerprint,
      ...(source === "event" ? { eventOwner: this.eventIdentity } : {}),
      source,
      status: "pending",
      attempts: 0,
      createdAt,
      nextAt: this.now(),
      expiresAt: createdAt + WINDOW_MS,
    };
    this.jobs.push(job);
    try {
      this.save();
    } catch {
      this.jobs.pop();
      throw new Error("Briefing state unavailable");
    }
    return true;
  }

  event(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(key))
      throw new Error("Briefing event needs a stable novaEventId");
    return this.enqueue("event", key);
  }

  schedule() {
    if (!this.time || this.closed) return;
    const parts = Object.fromEntries(
      this.formatter
        .formatToParts(new Date(this.now()))
        .map((part) => [part.type, part.value]),
    );
    const [hour, minute] = this.time.split(":").map(Number);
    let elapsed =
      Number(parts.hour) * 60 + Number(parts.minute) - hour * 60 - minute;
    const date = new Date(
      `${parts.year}-${parts.month}-${parts.day}T12:00:00Z`,
    );
    if (elapsed < 0) {
      elapsed += 1440;
      date.setUTCDate(date.getUTCDate() - 1);
    }
    if (elapsed > 240) return;
    const day = date.toISOString().slice(0, 10);
    this.enqueue(
      "schedule",
      `${day}:${this.time}`,
      this.now() - elapsed * 60000,
    );
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.pump().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async pump() {
    if (this.needsReload) {
      this.jobs = this.load();
      this.needsReload = false;
    }
    this.schedule();
    for (const job of this.jobs) {
      if (this.closed) return;
      if (!["pending", "reply"].includes(job.status)) continue;
      if (
        (job.source === "event"
          ? job.eventOwner !== this.eventIdentity
          : job.fingerprint !== this.fingerprint) ||
        this.now() > job.expiresAt ||
        job.attempts >= MAX_ATTEMPTS
      ) {
        job.status = "failed";
        this.save();
        continue;
      }
      if (this.now() < job.nextAt) continue;
      job.attempts++;
      job.nextAt =
        this.now() + Math.min(15 * 60000, 30000 * 2 ** (job.attempts - 1));
      this.save(); // Persist attempt/backoff before any network effect.
      try {
        if (job.status === "pending") {
          const reply = await this.ask(this.kind);
          if (this.closed || !this.jobs.includes(job)) return;
          if (typeof reply !== "string" || !reply.trim()) throw new Error();
          const trimmed = reply.trim();
          job.reply =
            trimmed.length > 240
              ? `${trimmed.slice(0, 225).replace(/\s+\S*$/, "")}… (ingekort)`
              : trimmed;
          job.status = "reply";
          job.attempts = 0;
          job.nextAt = this.now();
          this.save();
          job.attempts++;
          job.nextAt = this.now() + 30000;
          this.save();
        }
        if (this.closed) return;
        await this.deliver({
          id: job.id,
          reply: job.reply,
          kind: this.kind,
          at: new Date(job.createdAt).toISOString(),
        });
        if (this.closed) return;
        job.status = "complete";
        this.save();
      } catch {
        // Reply survives failed delivery; retry uses the same durable acceptance ID.
        // A failed save must stop this pump; memory alone cannot acknowledge work.
        if (this.needsReload) throw new Error("Briefing state unavailable");
        this.save();
      }
      return; // At most one job per polling tick.
    }
  }

  async close() {
    this.closed = true;
    try {
      await this.running;
    } finally {
      owners.delete(this.file);
    }
  }
}
module.exports = { BriefingState };
