import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  DataBackupService,
  dueBackupSlots,
} from "../../src/dashboard/data-backup.service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-data-backup-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "settings.json"), '{"private":true}\n', {
    mode: 0o600,
  });
  const alerts = { record: vi.fn() };
  const service = new DataBackupService(
    { dataDir, backupDir, timezone: "Europe/Amsterdam" } as NovaConfig,
    alerts as never,
  );
  return { root, dataDir, backupDir, alerts, service };
}

describe("scheduled NOVA data backups", () => {
  it("creates and verifies daily and weekly private archives, then announces both", async () => {
    const { root, dataDir, backupDir, alerts, service } = fixture();
    const now = new Date("2026-10-11T01:40:00.000Z");
    await service.checkSchedule(now);

    const names = fs.readdirSync(backupDir).sort();
    expect(names).toEqual([
      "daily-2026-10-11.tar.gz",
      "weekly-2026-W41.tar.gz",
    ]);
    for (const name of names) {
      const file = path.join(backupDir, name);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const listing = spawnSync("tar", ["--list", "--gzip", `--file=${file}`], {
        encoding: "utf8",
      });
      expect(listing.status).toBe(0);
      expect(listing.stdout).toContain("./settings.json");
    }
    const restoreDir = path.join(root, "restore");
    fs.mkdirSync(restoreDir);
    const restored = spawnSync(
      "tar",
      ["--extract", "--gzip", `--file=${path.join(backupDir, names[0]!)}`],
      { cwd: restoreDir },
    );
    expect(restored.status).toBe(0);
    expect(
      fs.readFileSync(path.join(restoreDir, "settings.json"), "utf8"),
    ).toBe('{"private":true}\n');
    expect(
      fs.statSync(path.join(restoreDir, "settings.json")).mode & 0o777,
    ).toBe(0o600);
    expect(alerts.record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(alerts.record.mock.calls)).toContain(
      "back-up gelukt",
    );
    expect(dueBackupSlots(now, "Europe/Amsterdam")).toHaveLength(2);
    expect(fs.readdirSync(dataDir)).toEqual(["settings.json"]);
  });

  it("excludes only the separate private Linphone bridge volume", async () => {
    const { dataDir, backupDir, alerts, service } = fixture();
    const bridge = path.join(dataDir, "linphone-chat");
    fs.mkdirSync(bridge, { mode: 0o700 });
    fs.writeFileSync(path.join(bridge, "chat.db"), "private bridge state");
    // Same name inside NOVA's workspace is ordinary application data.
    fs.mkdirSync(path.join(dataDir, "workspace", "linphone-chat"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataDir, "workspace", "linphone-chat", "notes.txt"),
      "keep this",
    );
    await service.checkSchedule(new Date("2026-10-12T01:40:00.000Z"));
    const listing = spawnSync(
      "tar",
      [
        "--list",
        "--gzip",
        `--file=${path.join(backupDir, "daily-2026-10-12.tar.gz")}`,
      ],
      { encoding: "utf8" },
    );
    expect(listing.status).toBe(0);
    const names = listing.stdout.split("\n");
    expect(names).toContain("./settings.json");
    expect(names).toContain("./workspace/linphone-chat/notes.txt");
    expect(names.some((name) => name.startsWith("./linphone-chat"))).toBe(
      false,
    );
    expect(fs.readFileSync(path.join(bridge, "chat.db"), "utf8")).toBe(
      "private bridge state",
    );
    expect(fs.statSync(bridge).mode & 0o777).toBe(0o700);
    expect(alerts.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ severity: "info" }),
      }),
    );
  });

  it("reports failures without exposing archive paths or process errors", async () => {
    const { root, alerts } = fixture();
    const bad = new DataBackupService(
      {
        dataDir: path.join(root, "missing"),
        backupDir: path.join(root, "failed-backups"),
        timezone: "Europe/Amsterdam",
      } as NovaConfig,
      alerts as never,
    );
    const first = new Date("2026-10-11T01:40:00.000Z");
    await bad.checkSchedule(first);
    await bad.checkSchedule(new Date(first.getTime() + 5 * 60_000));
    await bad.checkSchedule(new Date(first.getTime() + 10 * 60_000));
    expect(alerts.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          severity: "critical",
          title: expect.stringContaining("back-up mislukt"),
          detail: "Controleer de beschikbare schijfruimte en de back-upmap.",
        }),
      }),
    );
  });

  it("retries a failed daily slot once its source becomes available", async () => {
    const { dataDir, backupDir, alerts, service } = fixture();
    fs.rmSync(dataDir, { recursive: true, force: true });
    const first = new Date("2026-10-12T01:40:00.000Z");
    await service.checkSchedule(first);
    expect(fs.readdirSync(backupDir)).toEqual([]);
    expect(alerts.record).not.toHaveBeenCalled();

    await fs.promises.mkdir(dataDir);
    await fs.promises.writeFile(path.join(dataDir, "settings.json"), "ready");
    await service.checkSchedule(new Date(first.getTime() + 4 * 60_000));
    expect(fs.readdirSync(backupDir)).toEqual([]);

    await service.checkSchedule(new Date(first.getTime() + 5 * 60_000));
    expect(fs.readdirSync(backupDir)).toContain("daily-2026-10-12.tar.gz");
    expect(alerts.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ severity: "info" }),
      }),
    );
  });

  it("replaces a corrupt archive instead of treating it as a successful backup", async () => {
    const { backupDir, service } = fixture();
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "daily-2026-10-11.tar.gz"), "broken");
    const first = new Date("2026-10-11T01:00:00.000Z");
    await service.checkSchedule(first);
    await service.checkSchedule(new Date(first.getTime() + 5 * 60_000));
    await service.checkSchedule(new Date(first.getTime() + 10 * 60_000));
    const file = path.join(backupDir, "daily-2026-10-11.tar.gz");
    const check = spawnSync("tar", ["--list", "--gzip", `--file=${file}`]);
    expect(check.status).toBe(0);
  });

  it("rejects backup directories nested inside or above the data directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-backup-path-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const alerts = { record: vi.fn() };
    expect(
      () =>
        new DataBackupService(
          { dataDir, backupDir: path.join(dataDir, "backups") } as NovaConfig,
          alerts as never,
        ),
    ).toThrow("must be separate");
    expect(
      () =>
        new DataBackupService(
          { dataDir, backupDir: root } as NovaConfig,
          alerts as never,
        ),
    ).toThrow("must be separate");
  });

  it("rejects backup-directory symlinks that point into the application data", async () => {
    const { root, dataDir, alerts } = fixture();
    const nested = path.join(dataDir, "nested-backups");
    fs.mkdirSync(nested);
    const link = path.join(root, "backup-link");
    fs.symlinkSync(nested, link, "dir");
    const service = new DataBackupService(
      { dataDir, backupDir: link, timezone: "Europe/Amsterdam" } as NovaConfig,
      alerts as never,
    );
    const first = new Date("2026-10-11T01:00:00.000Z");
    await service.checkSchedule(first);
    await service.checkSchedule(new Date(first.getTime() + 5 * 60_000));
    await service.checkSchedule(new Date(first.getTime() + 10 * 60_000));
    expect(fs.statSync(dataDir).mode & 0o777).not.toBe(0o700);
    expect(fs.readdirSync(nested)).toEqual([]);
    expect(alerts.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ severity: "critical" }),
      }),
    );
  });
});
