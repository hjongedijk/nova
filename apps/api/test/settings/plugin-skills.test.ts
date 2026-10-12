import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { loadPluginSkills } from "../../src/settings/skills/plugin-skills.js";
import { SkillsSource } from "../../src/settings/skills/skills.source.js";
import type { SettingsStore } from "../../src/settings/store/settings.store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-plugins-"));
const directory = path.join(root, "plugins");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function manifest(name: string) {
  return {
    type: "webhook",
    name,
    description: "Read the service status when explicitly asked",
    risk: "READ_ONLY",
    http: { method: "GET", url: "https://example.org/status" },
  };
}

function save(name: string, value: unknown, mode = 0o600) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode });
  fs.chmodSync(file, mode);
  return file;
}

describe("local declarative plugin folder", () => {
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("loads a private JSON webhook through the existing tool safety path", () => {
    fs.mkdirSync(directory, { mode: 0o700 });
    save("status.json", manifest("Status"));
    const plugins = loadPluginSkills(directory);
    expect(plugins).toMatchObject([
      { id: "status", type: "webhook", risk: "READ_ONLY" },
    ]);
    const settings = {
      get: () => ({ skills: [] }),
    } as unknown as SettingsStore;
    const source = new SkillsSource(settings, { dataDir: root } as NovaConfig);
    expect(source.definitions()).toMatchObject([
      { name: "skill_status", risk: "READ_ONLY" },
    ]);
    const disabled = {
      get: () => ({
        skills: [{ id: "status", type: "webhook", enabled: false }],
      }),
    } as unknown as SettingsStore;
    expect(
      new SkillsSource(disabled, { dataDir: root } as NovaConfig).definitions(),
    ).toEqual([]);
  });

  it("ignores symlinks, open permissions, executable files and malformed manifests", () => {
    fs.mkdirSync(directory, { mode: 0o700 });
    save("valid.json", manifest("Valid"));
    save("public.json", manifest("Public"), 0o644);
    save("instruction.json", {
      type: "instruction",
      name: "Playbook",
      instructions: "Do this",
    });
    fs.writeFileSync(path.join(directory, "code.js"), "process.exit(1)");
    fs.symlinkSync(
      path.join(directory, "valid.json"),
      path.join(directory, "linked.json"),
    );
    fs.writeFileSync(path.join(directory, "broken.json"), "{", { mode: 0o600 });
    expect(loadPluginSkills(directory).map((skill) => skill.id)).toEqual([
      "valid",
    ]);
    fs.chmodSync(directory, 0o755);
    expect(loadPluginSkills(directory)).toEqual([]);
  });
});
