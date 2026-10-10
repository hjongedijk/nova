import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    ),
);

describe("the settings-page backup", () => {
  it("preserves the exact original privately and does not overwrite it", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-settings-backup-"),
    );
    directories.push(directory);
    const file = path.join(directory, "settings.json");
    const original = JSON.stringify({
      version: 1,
      persona: "Kort",
      skills: [{ secret: "private-fixture" }],
      widgets: [{ id: "note" }],
      sidebar: { items: [{ id: "note" }] },
    });
    fs.writeFileSync(file, original);
    const store = new SettingsStore({
      dataFile: () => file,
    } as unknown as NovaConfig);
    store.backupBeforeSettingsPage();
    const backup = `${file}.before-settings-page-v1`;
    expect(fs.readFileSync(backup, "utf8")).toBe(original);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    store.update((settings) => {
      settings.persona = "Nieuwe regels";
    });
    store.backupBeforeSettingsPage();
    expect(fs.readFileSync(backup, "utf8")).toBe(original);
    const restored = JSON.parse(fs.readFileSync(backup, "utf8"));
    expect(restored.skills).toEqual([{ secret: "private-fixture" }]);
    expect(restored.sidebar.items[0].id).toBe("note");
  });
  it("does not create data on a fresh installation", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-settings-backup-"),
    );
    directories.push(directory);
    const file = path.join(directory, "settings.json");
    const store = new SettingsStore({
      dataFile: () => file,
    } as unknown as NovaConfig);
    store.backupBeforeSettingsPage();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
