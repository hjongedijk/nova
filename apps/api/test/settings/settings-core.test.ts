import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { publicOrigin } from "../../src/core/public-url.js";
import { groupTools } from "../../src/settings/abilities.js";
import {
  BUILTIN_PANELS,
  normalizePersona,
  normalizeQuickActions,
  normalizeSidebar,
  normalizeToolOverride,
  resolveSidebar,
} from "../../src/settings/settings-validation.js";
import {
  DEFAULT_QUICK_ACTIONS,
  SettingsStore,
} from "../../src/settings/store/settings.store.js";
import { createApp, problem, type TestApp } from "./helpers.js";

const config = new NovaConfig();
const dir = config.dataDir;
const store = new SettingsStore(config);
beforeEach(() => {
  fs.rmSync(path.join(dir, "settings.json"), { force: true });
  store.reset();
});

describe("the store", () => {
  it("starts empty, survives a restart, and the file is private", () => {
    expect(store.get().skills).toEqual([]);
    expect(store.quickActions()).toEqual(DEFAULT_QUICK_ACTIONS);
    store.update((settings) => void (settings.persona = "Wees kort."));
    store.reset(); // a restart: memory is gone, the file stays
    expect(store.get().persona).toBe("Wees kort.");
    expect(fs.statSync(path.join(dir, "settings.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    ).toHaveLength(0);
  });

  it("sets a damaged settings file aside, not silently overwritten", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{kapot");
    expect(store.get().skills).toEqual([]);
    expect(
      fs
        .readdirSync(dir)
        .some((name) => name.startsWith("settings.json.damaged-")),
    ).toBe(true);
  });

  it("changes a copy: a failing change leaves the saved settings alone", () => {
    store.update((settings) => void (settings.persona = "een"));
    expect(() =>
      store.update(() => {
        throw new Error("mislukt");
      }),
    ).toThrow(/mislukt/);
    expect(store.get().persona).toBe("een");
    const copy = store.get();
    copy.persona = "gewijzigd";
    expect(store.get().persona).toBe("een");
  });
});

describe("validation", () => {
  it("checks personal rules and quick actions", () => {
    expect(normalizePersona("  kort  ")).toBe("kort");
    expect(() => normalizePersona("x".repeat(2001))).toThrow(/te lang/);
    expect(() => normalizePersona(5)).toThrow(/tekst/);
    expect(
      normalizeQuickActions([{ label: " Weer ", prompt: "Wat is het weer?" }]),
    ).toEqual([{ label: "Weer", prompt: "Wat is het weer?" }]);
    expect(() => normalizeQuickActions("nee")).toThrow(/lijst/);
    expect(() =>
      normalizeQuickActions(
        Array.from({ length: 9 }, () => ({ label: "a", prompt: "b" })),
      ),
    ).toThrow(/Maximaal 8/);
    expect(
      problem(() => normalizeQuickActions([{ label: "", prompt: "x" }])),
    ).toMatch(/knoptekst is verplicht/);
    expect(
      problem(() =>
        normalizeQuickActions([{ label: "x".repeat(41), prompt: "x" }]),
      ),
    ).toMatch(/te lang/);
  });

  it("keeps only what differs from the default in a tool override", () => {
    expect(
      normalizeToolOverride("echo", { enabled: true, description: "" }),
    ).toEqual({});
    expect(normalizeToolOverride("echo", { enabled: false })).toEqual({
      enabled: false,
    });
    expect(
      normalizeToolOverride("echo", {
        description: "Geef de tekst terug zoals hij is",
      }),
    ).toEqual({ description: "Geef de tekst terug zoals hij is" });
    expect(() => normalizeToolOverride("slecht naam!", {})).toThrow(
      /Ongeldige toolnaam/,
    );
    expect(() => normalizeToolOverride("echo", { enabled: "ja" })).toThrow(
      /waar of onwaar/,
    );
    expect(() =>
      normalizeToolOverride("echo", { description: "kort" }),
    ).toThrow(/te kort/);
  });

  it("shows every built-in panel, drops removed ones and puts new panels at the end", () => {
    const base = store.get();
    const defaults = resolveSidebar(base);
    expect(defaults).toHaveLength(BUILTIN_PANELS.length);
    expect(defaults.every((item) => item.shown)).toBe(true);
    const withWidget = { ...base, widgets: [{ id: "x" }] };
    expect(resolveSidebar(withWidget).at(-1)?.id).toBe("w:x");
    const saved = normalizeSidebar(
      [{ id: "huis", column: "right", page: 9, shown: false }],
      withWidget,
    );
    expect(saved[0]).toEqual({
      id: "huis",
      column: "right",
      page: 3,
      shown: false,
    });
    const resolved = resolveSidebar({
      ...withWidget,
      sidebar: { items: saved },
    });
    expect(resolved[0]?.id).toBe("huis");
    expect(resolved).toHaveLength(BUILTIN_PANELS.length + 1);
    expect(
      problem(() => normalizeSidebar([{ id: "bestaat-niet" }], base)),
    ).toMatch(/Onbekend/);
    expect(
      problem(() => normalizeSidebar([{ id: "huis" }, { id: "huis" }], base)),
    ).toMatch(/twee keer/);
  });

  it("keeps only the origin of the public address, so links carry no port or path", () => {
    expect(publicOrigin("https://nova.example.com/")).toBe(
      "https://nova.example.com",
    );
    expect(publicOrigin("https://nova.example.com/app?x=1")).toBe(
      "https://nova.example.com",
    );
    expect(publicOrigin("https://nova.example.com:8443")).toBe(
      "https://nova.example.com:8443",
    );
    expect(publicOrigin("")).toBe("");
    expect(publicOrigin("nova.example.com")).toBe("");
    expect(publicOrigin("ftp://nova.example.com")).toBe("");
    expect(publicOrigin("https://user:pw@nova.example.com")).toBe("");
  });
});

describe("abilities", () => {
  it("group the tools in plain language", () => {
    const groups = groupTools([
      { name: "timer_set", enabled: true },
      { name: "list_add", enabled: false },
      { name: "volledig_onbekend", enabled: true },
      { name: "skill_eigen", enabled: true },
    ]);
    const planning = groups.find((group) => group.id === "planning");
    expect(planning?.state).toBe("partial");
    expect(planning?.total).toBe(2);
    expect(planning?.example).toBeTruthy();
    expect(groups.every((group) => group.total > 0)).toBe(true);
    expect(groups.find((group) => group.id === "overig")?.tools).toEqual([
      "volledig_onbekend",
    ]);
    expect(groups.flatMap((group) => group.tools)).not.toContain("skill_eigen");
  });
});

describe("tool overrides reach the model", () => {
  let nova: TestApp;
  beforeAll(async () => {
    nova = await createApp();
  });
  afterAll(() => nova.app.close());
  beforeEach(() => nova.store.reset());

  it("switches a tool off, edits its description, and can undo it", () => {
    nova.store.update(
      (settings) =>
        void (settings.toolOverrides = {
          echo: { enabled: false, description: "Mijn eigen uitleg voor echo" },
        }),
    );
    const echo = nova.tools.list().find((tool) => tool.name === "echo");
    expect(echo).toMatchObject({
      enabled: false,
      switchedOff: true,
      edited: true,
      description: "Mijn eigen uitleg voor echo",
      defaultDescription: "Return supplied text",
    });
    expect(
      nova.tools.forModel().map((tool) => tool.function.name),
    ).not.toContain("echo");
    nova.store.update((settings) => void (settings.toolOverrides = {}));
    expect(
      nova.tools.list().find((tool) => tool.name === "echo")?.enabled,
    ).toBe(true);
  });
});
