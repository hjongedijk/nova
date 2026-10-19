import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientPreferencesController } from "../../src/settings/client-preferences.controller.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { closeNovaDb } from "../../src/core/db/nova-db.js";

const dirs: string[] = [];
function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-shared-prefs-"));
  dirs.push(dir);
  const config = {
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
  return {
    dir,
    prefs: new ClientPreferencesController(config),
    second: new ClientPreferencesController(config),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeNovaDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
describe("shared client preferences", () => {
  it("keeps independent edits and refuses stale initialization overwrites across instances", () => {
    const { dir, prefs, second } = controller();
    prefs.put({ values: { novaVolume: "0.7" } });
    second.put({ values: { novaWake: "on" } });
    expect(
      prefs.put({
        initialize: true,
        values: { novaVolume: "0.1", novaPanels: "off" },
      }),
    ).toEqual({
      values: { novaVolume: "0.7", novaWake: "on", novaPanels: "off" },
    });
    expect(second.get()).toEqual(prefs.get());
    expect(fs.existsSync(path.join(dir, "nova.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "client-preferences.json"))).toBe(
      false,
    );
  });
  it("syncs a complete supported pronunciation dictionary with Unicode entries", () => {
    const { prefs } = controller();
    const rules = Array.from({ length: 100 }, (_, index) => ({
      term: String(index) + "語".repeat(77),
      say: "声".repeat(120),
    }));
    const value = JSON.stringify(rules);
    expect(Buffer.byteLength(value)).toBeGreaterThan(8192);
    prefs.put({ values: { novaPronunciations: value } });
    expect(prefs.get().values.novaPronunciations).toBe(value);
  });
  it("rejects device identifiers, unknown fields and oversized values without changing saved choices", () => {
    const { prefs } = controller();
    prefs.put({ values: { novaVolume: "1" } });
    for (const body of [
      { values: { novaAudioInput: "private" } },
      { values: { novaVolume: 0.5 } },
      { values: { novaVolume: "a".repeat(65537) } },
      { values: { novaWake: "on" }, token: "secret" },
    ])
      expect(() => prefs.put(body)).toThrow();
    expect(prefs.get()).toEqual({ values: { novaVolume: "1" } });
  });
});
