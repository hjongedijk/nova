import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import {
  buildBackupPlan,
  MAX_BACKUP_BYTES,
} from "../../src/settings/backup-plan.js";
import {
  normalizeSkill,
  publicSkill,
} from "../../src/settings/skills/skills.js";
import type { NovaSettings } from "../../src/settings/store/settings.store.js";

const instruction = (name = "Filmavond", id?: string) => ({
  type: "instruction",
  name,
  instructions: "Dim de lampen.",
  ...(id ? { id } : {}),
});
const webhook = (id = "dienst") => ({
  id,
  type: "webhook",
  name: "Dienst",
  description: "Gegevens van de dienst lezen",
  http: {
    method: "GET",
    url: "https://service.example/status",
    secretHeaders: [{ name: "X-Token", set: true }],
  },
});
const note = (id = "notitie") => ({
  id,
  type: "note",
  title: "Notitie",
  text: "Onthoud dit.",
});
const backup = (fields = {}) => ({
  format: "nova-settings",
  version: 1,
  ...fields,
});
function current(): NovaSettings {
  return {
    version: 1,
    persona: "Bestaande regels",
    quickActions: [{ label: "Status", prompt: "Geef de status" }],
    toolOverrides: { echo: { enabled: false } },
    skills: [],
    widgets: [],
    sidebar: null,
    standingApprovals: [
      {
        id: "grant",
        tool: "echo",
        argsHash: "private-grant",
        schemaHash: "hash",
        createdAt: 1,
      },
    ],
    helper: { mode: "helper", display: 2 },
    helperPreferences: {
      autohide: true,
      contrast: false,
      shape: "orb",
      cues: {
        enabled: true,
        volume: 0.35,
        theme: "soft",
        quiet: { enabled: false, start: "22:00", end: "07:00" },
      },
    },
  };
}
const storedWebhook = () =>
  normalizeSkill({
    ...webhook(),
    http: {
      ...webhook().http,
      secretHeaders: [{ name: "X-Token", value: "stored-private-token" }],
    },
  });
const rejects = (data: unknown, mode: unknown = "merge", state = current()) =>
  expect(() => buildBackupPlan(data, mode, state)).toThrow(ValidationError);

describe("bounded private settings backup plan", () => {
  it("accepts the actual public export shape without restoring exported secret declarations", () => {
    const exported = publicSkill(storedWebhook());
    const { next, summary } = buildBackupPlan(
      backup({ skills: [exported] }),
      "replace",
      current(),
    );
    expect(
      (next.skills[0]!.http as { secretHeaders: unknown[] }).secretHeaders,
    ).toEqual([]);
    expect(summary.missingSecrets).toEqual([
      { skill: "Dienst", headers: ["X-Token"] },
    ]);
    expect(JSON.stringify(next)).not.toContain("stored-private-token");
  });
  it.each(["merge", "replace"])(
    "preserves legacy optional helper fields for %s",
    (mode) => {
      const state = current();
      const { next, summary } = buildBackupPlan(backup(), mode, state);
      expect(next.helper).toEqual(state.helper);
      expect(next.helperPreferences).toEqual(state.helperPreferences);
      expect(summary).toMatchObject({
        helperChanged: false,
        helperPreferencesChanged: false,
      });
      expect(next.helper).not.toBe(state.helper);
      expect(next.helperPreferences).not.toBe(state.helperPreferences);
    },
  );
  it("imports complete canonical helper preferences with independent change flags", () => {
    const state = current();
    const preferences = {
      ...state.helperPreferences,
      shape: "mist",
      wardrobe: { theme: "gold", seasonal: true, birthday: "12-25" },
      cues: {
        ...state.helperPreferences.cues,
        theme: "playful",
        cues: { greet: false, goodnight: true },
      },
    };
    const data = backup({
      helper: { mode: "both", display: 8 },
      helperPreferences: preferences,
    });
    const before = structuredClone(data);
    const { next, summary } = buildBackupPlan(data, "replace", state);
    expect(next.helper).toEqual({ mode: "both", display: 8 });
    expect(next.helperPreferences).toEqual(preferences);
    expect(summary).toMatchObject({
      helperChanged: true,
      helperPreferencesChanged: true,
    });
    expect(next.standingApprovals).toEqual(state.standingApprovals);
    expect(JSON.stringify(summary)).not.toContain("private-grant");
    expect(data).toEqual(before);
    expect(state.helper).toEqual({ mode: "helper", display: 2 });
    next.helperPreferences.wardrobe!.theme = "nova";
    expect(preferences.wardrobe.theme).toBe("gold");
  });
  it("canonicalizes omitted per-cue defaults and reports unchanged canonical roundtrip", () => {
    const state = current();
    const normalized = buildBackupPlan(
      backup({ helperPreferences: state.helperPreferences }),
      "merge",
      state,
    ).next;
    expect(normalized.helperPreferences.cues.cues).toEqual({});
    const result = buildBackupPlan(
      backup({
        helper: normalized.helper,
        helperPreferences: normalized.helperPreferences,
      }),
      "merge",
      normalized,
    );
    expect(result.summary).toMatchObject({
      helperChanged: false,
      helperPreferencesChanged: false,
    });
    expect(result.next.helperPreferences).toEqual(normalized.helperPreferences);
  });
  it.each([
    null,
    undefined,
    [],
    {},
    { mode: "both" },
    { display: 0 },
    { mode: "invalid", display: 0 },
    { mode: "both", display: "0" },
    { mode: "both", display: -1 },
    { mode: "both", display: 9 },
    { mode: "both", display: 1.5 },
    { mode: "both", display: 0, apiKey: "private-token" },
  ])("rejects malformed helper choice %j", (helper) =>
    rejects(backup({ helper })),
  );
  it.each(["root", "cues", "quiet", "wardrobe", "perCue"])(
    "rejects unknown sensitive helper preference fields in %s",
    (where) => {
      const preferences: Record<string, unknown> = structuredClone(
        current().helperPreferences,
      ) as unknown as Record<string, unknown>;
      const cues = preferences.cues as Record<string, unknown>;
      if (where === "root") preferences.apiKey = "private-token";
      if (where === "cues") cues.apiKey = "private-token";
      if (where === "quiet")
        (cues.quiet as Record<string, unknown>).password = "private-token";
      if (where === "wardrobe")
        preferences.wardrobe = {
          theme: "gold",
          seasonal: true,
          birthday: "",
          accessToken: "private-token",
        };
      if (where === "perCue") cues.cues = { apiKey: true };
      rejects(backup({ helperPreferences: preferences }));
    },
  );
  it.each([null, undefined, [], {}, "preferences"])(
    "rejects malformed helper preferences %j",
    (helperPreferences) => rejects(backup({ helperPreferences })),
  );
  it.each(["cues", "quiet", "wardrobe", "perCue"])(
    "rejects malformed nested helper preference %s",
    (where) => {
      for (const invalid of [null, undefined, [], "invalid"]) {
        const preferences = structuredClone(
          current().helperPreferences,
        ) as unknown as Record<string, unknown>;
        const cues = preferences.cues as Record<string, unknown>;
        if (where === "cues") preferences.cues = invalid;
        if (where === "quiet") cues.quiet = invalid;
        if (where === "wardrobe") preferences.wardrobe = invalid;
        if (where === "perCue") cues.cues = invalid;
        rejects(backup({ helperPreferences: preferences }));
      }
    },
  );
  it("reuses existing helper value validation with bounded volumes and fixed errors", () => {
    for (const volume of [-1, 1.01, NaN, Infinity, "0.5"]) {
      const preferences = current().helperPreferences;
      rejects(
        backup({
          helperPreferences: {
            ...preferences,
            cues: { ...preferences.cues, volume },
          },
        }),
      );
    }
    const preferences = current().helperPreferences;
    rejects(
      backup({ helperPreferences: { ...preferences, shape: "private-token" } }),
    );
    rejects(
      backup({
        helperPreferences: {
          ...preferences,
          cues: {
            ...preferences.cues,
            quiet: { enabled: true, start: "25:00", end: "07:00" },
          },
        },
      }),
    );
    rejects(
      backup({
        helperPreferences: {
          ...preferences,
          wardrobe: { theme: "gold", seasonal: false, birthday: "99-99" },
        },
      }),
    );
  });
  it("includes helper preferences and choice in the complete public secret scan", () => {
    const preferences = {
      ...current().helperPreferences,
      wardrobe: { theme: "gold", seasonal: true, birthday: "12-25" },
    };
    const secretSkill = (value: string) => ({
      ...webhook(),
      http: { ...webhook().http, secretHeaders: [{ name: "X-Token", value }] },
    });
    rejects(
      backup({
        skills: [secretSkill("12-25")],
        helperPreferences: preferences,
      }),
    );
    rejects(
      backup({
        skills: [secretSkill("both")],
        helper: { mode: "both", display: 1 },
      }),
    );
    const state = current();
    state.helperPreferences = {
      ...state.helperPreferences,
      wardrobe: { theme: "gold", seasonal: true, birthday: "12-25" },
    };
    const stored = normalizeSkill(secretSkill("12-25"));
    state.skills = [stored as unknown as Record<string, unknown>];
    rejects(backup(), "merge", state);
  });
  it("merges detached settings while preserving excluded settings and optional fields", () => {
    const state = current();
    const before = structuredClone(state);
    const data = backup({ skills: [instruction()], widgets: [note()] });
    const rawBefore = structuredClone(data);
    const { next, summary } = buildBackupPlan(data, "merge", state);
    expect(next.persona).toBe(state.persona);
    expect(next.quickActions).toEqual(state.quickActions);
    expect(next.helper).toEqual(state.helper);
    expect(next.helperPreferences).toEqual(state.helperPreferences);
    expect(next.standingApprovals).toEqual(state.standingApprovals);
    expect(next.toolOverrides).toEqual(state.toolOverrides);
    expect(next.skills[0]).toMatchObject({ id: "filmavond", version: 1 });
    expect(summary).toEqual({
      mode: "merge",
      incomingSkills: 1,
      totalSkills: 1,
      incomingWidgets: 1,
      totalWidgets: 1,
      replacedSkills: 0,
      removedSkills: 0,
      removedWidgets: 0,
      personaChanged: false,
      quickActionsChanged: false,
      toolOverridesChanged: false,
      sidebarChanged: false,
      helperChanged: false,
      helperPreferencesChanged: false,
      missingSecrets: [],
    });
    expect(state).toEqual(before);
    expect(data).toEqual(rawBefore);
    next.helper.display = 0;
    expect(state.helper.display).toBe(2);
  });
  it("replaces lists with an explicit removal summary and keeps omitted persona/actions/sidebar", () => {
    const state = current();
    state.skills = [
      normalizeSkill(instruction("Oud")) as unknown as Record<string, unknown>,
    ];
    state.widgets = [note("oud_paneel")];
    state.sidebar = {
      items: [{ id: "systeem", column: "left", page: 1, shown: false }],
    };
    const { next, summary } = buildBackupPlan(backup(), "replace", state);
    expect(next.skills).toEqual([]);
    expect(next.widgets).toEqual([]);
    expect(next.sidebar).toEqual(state.sidebar);
    expect(next.persona).toBe(state.persona);
    expect(next.quickActions).toEqual(state.quickActions);
    expect(next.toolOverrides).toEqual({});
    expect(summary).toMatchObject({ removedSkills: 1, removedWidgets: 1 });
  });
  it("preserves stable exported IDs despite renamed labels and restarts skill version at one", () => {
    const data = backup({
      skills: [{ ...instruction("Hernoemd", "stable_skill"), version: 9 }],
      widgets: [{ ...note("stable_widget"), title: "Nieuwe titel" }],
      sidebar: [
        { id: "w:stable_widget", column: "right", page: 3, shown: true },
      ],
    });
    const { next } = buildBackupPlan(data, "replace", current());
    expect(next.skills[0]).toMatchObject({ id: "stable_skill", version: 1 });
    expect(next.widgets[0]!.id).toBe("stable_widget");
    expect(next.sidebar!.items[0]!.id).toBe("w:stable_widget");
  });
  it("preserves only stored matching credentials for a compatible merge collision", () => {
    const state = current();
    state.skills = [storedWebhook() as unknown as Record<string, unknown>];
    const imported = webhook();
    imported.http.secretHeaders = [{ name: "x-token", set: true }];
    const { next, summary } = buildBackupPlan(
      backup({ skills: [imported] }),
      "merge",
      state,
    );
    expect(
      (next.skills[0]!.http as { secretHeaders: unknown[] }).secretHeaders,
    ).toEqual([{ name: "x-token", value: "stored-private-token" }]);
    expect(summary.missingSecrets).toEqual([]);
    expect(summary.replacedSkills).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("stored-private-token");
  });
  it("ignores even supplied secret values and keeps the stored secret only on exact binding", () => {
    const state = current();
    state.skills = [storedWebhook() as unknown as Record<string, unknown>];
    const data = backup({
      skills: [
        {
          ...webhook(),
          http: {
            ...webhook().http,
            secretHeaders: [
              { name: "X-Token", value: "incoming-private-token" },
            ],
          },
        },
      ],
    });
    const merged = buildBackupPlan(data, "merge", state);
    expect(JSON.stringify(merged.next)).not.toContain("incoming-private-token");
    expect(JSON.stringify(merged.next)).toContain("stored-private-token");
    const replaced = buildBackupPlan(data, "replace", state);
    expect(JSON.stringify(replaced.next)).not.toContain("private-token");
    expect(replaced.summary.missingSecrets).toEqual([
      { skill: "Dienst", headers: ["X-Token"] },
    ]);
  });
  it.each(["url", "method", "declarations", "omitted", "type"])(
    "strips stored secrets and reports missing names for incompatible %s",
    (change) => {
      const state = current();
      state.skills = [storedWebhook() as unknown as Record<string, unknown>];
      let imported: unknown = webhook();
      if (change === "url")
        imported = {
          ...webhook(),
          http: { ...webhook().http, url: "https://other.example/status" },
        };
      if (change === "method")
        imported = {
          ...webhook(),
          http: { ...webhook().http, method: "POST" },
        };
      if (change === "declarations")
        imported = {
          ...webhook(),
          http: {
            ...webhook().http,
            secretHeaders: [{ name: "X-Other", set: true }],
          },
        };
      if (change === "omitted")
        imported = {
          ...webhook(),
          http: { method: "GET", url: webhook().http.url },
        };
      if (change === "type") imported = instruction("Dienst", "dienst");
      const result = buildBackupPlan(
        backup({ skills: [imported] }),
        "merge",
        state,
      );
      expect(JSON.stringify(result.next)).not.toContain("stored-private-token");
      expect(result.summary.missingSecrets[0]!.headers).toContain("X-Token");
    },
  );
  it("rejects recognized secrets in names instead of persisting a scrubbed summary", () => {
    const imported = {
      ...webhook(),
      name: "Bearer recognized-token",
      http: {
        ...webhook().http,
        secretHeaders: [{ name: "X-Token", value: "recognized-token" }],
      },
    };
    rejects(backup({ skills: [imported] }), "replace");
    try {
      buildBackupPlan(backup({ skills: [imported] }), "replace", current());
    } catch (error) {
      expect((error as Error).message).not.toContain("recognized-token");
    }
  });
  it.each([
    "name",
    "description",
    "header",
    "body",
    "widget",
    "persona",
    "actions",
    "override",
    "id",
    "key",
  ])("rejects a declared secret reused in public %s", (field) => {
    const secret = "private_repeat_value";
    const imported: Record<string, unknown> = {
      ...webhook(),
      http: {
        ...webhook().http,
        secretHeaders: [{ name: "X-Token", value: secret }],
      },
    };
    const data: Record<string, unknown> = backup({ skills: [imported] });
    if (field === "name") imported.name = secret;
    if (field === "description")
      imported.description = `Beschrijving ${secret}`;
    if (field === "header")
      imported.http = {
        ...(imported.http as object),
        headers: [{ name: "X-Public", value: secret }],
      };
    if (field === "body")
      imported.http = {
        ...(imported.http as object),
        method: "POST",
        body: secret,
      };
    if (field === "widget") data.widgets = [{ ...note(), text: secret }];
    if (field === "persona") data.persona = `Regels ${secret}`;
    if (field === "actions")
      data.quickActions = [{ label: "Actie", prompt: secret }];
    if (field === "override")
      data.toolOverrides = { echo: { description: `Beschrijving ${secret}` } };
    if (field === "id") imported.id = secret;
    if (field === "key") data.toolOverrides = { [secret]: { enabled: false } };
    rejects(data, "replace");
  });
  it("rejects forward secret references in earlier imported skills", () => {
    const secret = "private_later_value";
    const first = { ...instruction("Eerste"), instructions: `Lees ${secret}` };
    const later = {
      ...webhook(),
      http: {
        ...webhook().http,
        secretHeaders: [{ name: "X-Token", value: secret }],
      },
    };
    rejects(backup({ skills: [first, later] }), "replace");
  });
  it("rejects recognized secret values and secret keys even without declarations", () => {
    rejects(backup({ persona: "Bearer recognized-private-value" }));
    rejects(
      backup({ toolOverrides: { "sk-abcdefghijklmno": { enabled: false } } }),
    );
  });
  it("rejects stored private values reused in incoming or retained public settings", () => {
    const state = current();
    state.skills = [storedWebhook() as unknown as Record<string, unknown>];
    rejects(backup({ persona: "stored-private-token" }), "merge", state);
    state.persona = "Existing stored-private-token reference";
    rejects(backup(), "merge", state);
  });
  it("matches short credentials exactly without rejecting benign substrings", () => {
    const state = current();
    const skill = normalizeSkill({
      ...webhook(),
      http: {
        ...webhook().http,
        secretHeaders: [{ name: "X-Token", value: "a" }],
      },
    });
    state.skills = [skill as unknown as Record<string, unknown>];
    expect(
      buildBackupPlan(
        backup({ skills: [webhook()], persona: "Wat kan Nova doen?" }),
        "merge",
        state,
      ).summary.missingSecrets,
    ).toEqual([]);
    rejects(backup({ persona: "a" }), "merge", state);
  });
  it.each([
    null,
    {},
    "headers",
    [null],
    [{ name: "bad header", set: true }],
    [{ name: "X-Nova-Pin", set: true }],
    [{ name: "X-Token", set: false }],
    [{ name: "X-Token", value: {} }],
    [{ name: "X-Token", extra: true }],
    [
      { name: "X-Token", set: true },
      { name: "x-token", set: true },
    ],
  ])("rejects malformed secret declarations: %j", (secretHeaders) =>
    rejects(
      backup({
        skills: [{ ...webhook(), http: { ...webhook().http, secretHeaders } }],
      }),
    ),
  );
  it("rejects duplicate plain/secret headers and excessive combined declarations", () => {
    rejects(
      backup({
        skills: [
          {
            ...webhook(),
            http: {
              ...webhook().http,
              headers: [{ name: "x-token", value: "public" }],
            },
          },
        ],
      }),
    );
    rejects(
      backup({
        skills: [
          {
            ...webhook(),
            http: {
              ...webhook().http,
              secretHeaders: Array.from({ length: 9 }, (_, index) => ({
                name: `X-Header-${index}`,
                set: true,
              })),
            },
          },
        ],
      }),
    );
  });
  it.each([
    null,
    [],
    "backup",
    {},
    backup({ version: 2 }),
    backup({ version: "1" }),
    backup({ format: "other" }),
  ])("rejects invalid format: %j", (value) => rejects(value));
  it.each([undefined, null, "", "unknown", true])(
    "requires an explicit import mode: %j",
    (mode) =>
      expect(() => buildBackupPlan(backup(), mode, current())).toThrow(
        ValidationError,
      ),
  );
  it.each(["services", "standingApprovals", "unknown"])(
    "rejects unsupported top-level field %s",
    (field) => rejects(backup({ [field]: {} })),
  );
  it.each(["skills", "widgets"])(
    "rejects supplied malformed %s lists",
    (field) => {
      for (const value of [null, undefined, {}, "list"])
        rejects(backup({ [field]: value }));
    },
  );
  it("bounds serialized UTF8 bytes and rejects non-JSON structures", () => {
    rejects(backup({ persona: "é".repeat(MAX_BACKUP_BYTES / 2) }));
    const cyclic = backup() as Record<string, unknown>;
    cyclic.skills = [cyclic];
    rejects(cyclic);
    rejects(backup({ persona: 1n }));
  });
  it("rejects duplicate normalized and explicit IDs for skills and widgets", () => {
    rejects(
      backup({ skills: [instruction("Filmavond"), instruction("Filmavond!")] }),
    );
    rejects(
      backup({
        skills: [instruction("Eerste", "same"), instruction("Tweede", "same")],
      }),
    );
    rejects(backup({ widgets: [note(), note()] }));
    rejects(backup({ skills: [instruction("Eerste", "bad-id!")] }));
  });
  it("rejects oversized incoming and merged lists without truncating current settings", () => {
    rejects(
      backup({
        skills: Array.from({ length: 51 }, (_, index) =>
          instruction(`Skill ${index}`),
        ),
      }),
    );
    rejects(
      backup({
        widgets: Array.from({ length: 21 }, (_, index) =>
          note(`widget_${index}`),
        ),
      }),
    );
    const state = current();
    state.skills = Array.from(
      { length: 50 },
      (_, index) =>
        normalizeSkill(instruction(`Skill ${index}`)) as unknown as Record<
          string,
          unknown
        >,
    );
    rejects(backup({ skills: [instruction("Extra")] }), "merge", state);
    expect(state.skills).toHaveLength(50);
    state.skills = [];
    state.widgets = Array.from({ length: 20 }, (_, index) =>
      note(`widget_${index}`),
    );
    rejects(backup({ widgets: [note("extra")] }), "merge", state);
    expect(state.widgets).toHaveLength(20);
  });
  it("validates imported and retained sidebar against the resulting widgets", () => {
    rejects(
      backup({ sidebar: [{ id: "w:missing", column: "left", page: 1 }] }),
    );
    rejects(backup({ sidebar: {} }));
    const state = current();
    state.widgets = [note()];
    state.sidebar = { items: [{ id: "w:notitie", column: "right", page: 3 }] };
    rejects(backup(), "replace", state);
    expect(
      buildBackupPlan(backup(), "merge", state).next.sidebar!.items[0]!.id,
    ).toBe("w:notitie");
    expect(
      buildBackupPlan(backup({ sidebar: null }), "replace", state).next.sidebar,
    ).toBeNull();
  });
  it("rejects dangling widget skill targets including retained panels after type replacement", () => {
    const widget = {
      id: "buttons",
      type: "buttons",
      title: "Knoppen",
      buttons: [{ label: "Lees", action: "skill", skillId: "dienst" }],
    };
    rejects(backup({ widgets: [widget] }));
    const state = current();
    state.skills = [storedWebhook() as unknown as Record<string, unknown>];
    state.widgets = [widget];
    rejects(
      backup({ skills: [instruction("Dienst", "dienst")] }),
      "merge",
      state,
    );
    expect(buildBackupPlan(backup(), "merge", state).next.widgets).toHaveLength(
      1,
    );
  });
  it("normalizes persona/actions/overrides before returning and never echoes invalid reference values", () => {
    const { next, summary } = buildBackupPlan(
      backup({
        persona: " Nieuwe regels ",
        quickActions: [{ label: " Test ", prompt: " Doe dit " }],
        toolOverrides: {
          echo: { description: "Een duidelijke nieuwe beschrijving" },
        },
      }),
      "merge",
      current(),
    );
    expect(summary).toMatchObject({
      personaChanged: true,
      quickActionsChanged: true,
      toolOverridesChanged: true,
      sidebarChanged: false,
    });
    expect(next.persona).toBe("Nieuwe regels");
    expect(next.quickActions).toEqual([{ label: "Test", prompt: "Doe dit" }]);
    expect(next.toolOverrides.echo).toEqual({
      description: "Een duidelijke nieuwe beschrijving",
    });
    try {
      buildBackupPlan(
        backup({ sidebar: [{ id: "raw-private-token" }] }),
        "merge",
        current(),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain("raw-private-token");
    }
  });
});
