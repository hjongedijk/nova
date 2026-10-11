import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NovaConfig } from "../core/config/nova-config.js";
import { AlertsFeed } from "./alerts-feed.service.js";

const CHECK_EVERY_MS = 30_000;
const DAILY_RETENTION = 14;
const WEEKLY_RETENTION = 8;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

type Slot = { kind: "daily" | "weekly"; key: string; name: string };

function localParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

export function dueBackupSlots(date: Date, timezone: string): Slot[] {
  const parts = localParts(date, timezone);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const slots: Slot[] = [];
  if (`${parts.hour}:${parts.minute}` >= "02:30")
    slots.push({ kind: "daily", key: day, name: `daily-${day}.tar.gz` });
  if (parts.weekday === "Sun" && `${parts.hour}:${parts.minute}` >= "03:30") {
    const utc = new Date(`${day}T00:00:00Z`);
    utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    const key = `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    slots.push({ kind: "weekly", key, name: `weekly-${key}.tar.gz` });
  }
  return slots;
}

/** Local, bounded archives of NOVA's application data. External service volumes are separate. */
@Injectable()
export class DataBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataBackupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly attempted = new Set<string>();
  private readonly backupDir: string;

  constructor(
    private readonly config: NovaConfig,
    private readonly alerts: AlertsFeed,
  ) {
    this.backupDir = config.backupDir;
    if (
      this.backupDir === config.dataDir ||
      this.backupDir.startsWith(`${config.dataDir}${path.sep}`) ||
      config.dataDir.startsWith(`${this.backupDir}${path.sep}`)
    )
      throw new Error("NOVA_BACKUP_DIR must be separate from NOVA_DATA_DIR");
  }

  onModuleInit(): void {
    void this.checkSchedule();
    this.timer = setInterval(() => void this.checkSchedule(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async checkSchedule(now = new Date()): Promise<void> {
    if (this.running) return;
    const slots = dueBackupSlots(now, this.config.timezone);
    for (const slot of slots) {
      const token = `${slot.kind}:${slot.key}`;
      if (this.attempted.has(token)) continue;
      this.attempted.add(token);
      this.running = true;
      try {
        const result = await this.create(slot);
        if (!result) continue;
        this.alerts.record({
          topic: "jarvis/alerts",
          payload: {
            title: `NOVA ${slot.kind === "daily" ? "dagelijkse" : "wekelijkse"} back-up gelukt`,
            detail: `${result.name} (${result.bytes} bytes).`,
            severity: "info",
            key: "nova-backup",
            at: now.toISOString(),
          },
        });
      } catch {
        this.logger.error(`${slot.kind} data backup failed`);
        this.alerts.record({
          topic: "jarvis/alerts",
          payload: {
            title: `NOVA ${slot.kind === "daily" ? "dagelijkse" : "wekelijkse"} back-up mislukt`,
            detail: "Controleer de beschikbare schijfruimte en de back-upmap.",
            severity: "critical",
            key: "nova-backup",
            at: now.toISOString(),
          },
        });
      } finally {
        this.running = false;
      }
    }
  }

  private async create(
    slot: Slot,
  ): Promise<{ name: string; bytes: number } | null> {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const backupStat = fs.lstatSync(this.backupDir);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink())
      throw new Error("Backup directory is not a real directory");
    const realDataDir = fs.realpathSync(this.config.dataDir);
    const realBackupDir = fs.realpathSync(this.backupDir);
    if (
      realBackupDir === realDataDir ||
      realBackupDir.startsWith(`${realDataDir}${path.sep}`) ||
      realDataDir.startsWith(`${realBackupDir}${path.sep}`)
    )
      throw new Error("Backup and data directories overlap");
    fs.chmodSync(this.backupDir, 0o700);
    const destination = path.join(this.backupDir, slot.name);
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (stat.isFile() && stat.size > 0) {
        try {
          await this.verifyTar(destination);
          return null;
        } catch {
          /* Replace a corrupt archive with a new complete archive. */
        }
      }
      fs.rmSync(destination, { force: true });
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await this.runTar(temporary);
      const stat = fs.statSync(temporary);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES)
        throw new Error("Backup archive size is invalid");
      await this.verifyTar(temporary);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, destination);
      this.prune(slot.kind);
      this.pruneTotal();
      return { name: slot.name, bytes: stat.size };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private runTar(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let written = 0;
      const child = spawn(
        "tar",
        [
          "--create",
          "--gzip",
          "--file=-",
          "--directory",
          this.config.dataDir,
          "--exclude=./*.tmp",
          "--exclude=./*.tmp.*",
          ".",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (chunk.length + written > MAX_ARCHIVE_BYTES) {
            callback(new Error("Backup archive exceeds size limit"));
            return;
          }
          written += chunk.length;
          callback(null, chunk);
        },
      });
      const closed = new Promise<number>((done, fail) => {
        child.once("error", fail);
        child.once("close", (code) => done(code ?? 1));
      });
      const writing = pipeline(
        child.stdout!,
        limiter,
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
      void Promise.all([closed, writing]).then(
        ([code]) =>
          code === 0 ? resolve() : reject(new Error("Archive creation failed")),
        async () => {
          child.kill("SIGTERM");
          await closed.catch(() => undefined);
          reject(new Error("Archive creation failed"));
        },
      );
    });
  }

  private verifyTar(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("tar", ["--list", "--gzip", `--file=${file}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.once("error", () =>
        reject(new Error("Archive verification failed")),
      );
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Archive verification failed")),
      );
    });
  }

  private prune(kind: Slot["kind"]): void {
    const prefix = `${kind}-`;
    const retention = kind === "daily" ? DAILY_RETENTION : WEEKLY_RETENTION;
    const files = fs
      .readdirSync(this.backupDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tar.gz"))
      .sort()
      .reverse();
    for (const name of files.slice(retention))
      fs.rmSync(path.join(this.backupDir, name), { force: true });
  }

  private pruneTotal(): void {
    const archives = fs
      .readdirSync(this.backupDir)
      .filter((name) =>
        /^(daily-\d{4}-\d{2}-\d{2}|weekly-\d{4}-W\d{2})\.tar\.gz$/.test(name),
      )
      .map((name) => ({
        name,
        size: fs.statSync(path.join(this.backupDir, name)).size,
        modified: fs.statSync(path.join(this.backupDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified);
    let total = archives.reduce((sum, archive) => sum + archive.size, 0);
    for (const archive of archives.reverse()) {
      if (total <= MAX_TOTAL_BYTES) break;
      fs.rmSync(path.join(this.backupDir, archive.name), { force: true });
      total -= archive.size;
    }
  }
}
