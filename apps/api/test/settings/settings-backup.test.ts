import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperPreferences } from "@nova/contracts";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import { SettingsBackupService } from "../../src/settings/settings-backup.service.js";
import type {
  NodeRedManagement,
  NodeRedFlowSnapshot,
} from "../../src/settings/node-red-management.service.js";
import { NodeRedFlowRevisions } from "../../src/settings/node-red-flow-revisions.service.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import type { WallpaperPort } from "../../src/settings/wallpaper.port.js";
import { ADMIN, createApp, playbook, webhook } from "./helpers.js";

const incoming = () => ({
  format: "nova-settings",
  version: 1,
  persona: "Private imported persona",
  skills: [
    playbook({
      name: "Private imported playbook",
      instructions: "Private imported instructions",
    }),
  ],
  widgets: [
    {
      type: "note",
      title: "Private note title",
      text: "Private note contents",
      enabled: true,
    },
  ],
});
const requestBody = () => ({
  data: incoming(),
  mode: "replace",
});
const helperChoice = { mode: "both" as const, display: 2 };
const helperPreferences: HelperPreferences = {
  autohide: false,
  contrast: true,
  shape: "mist",
  notifications: {
    info: "screen",
    briefing: "speak",
    warning: "helper",
    critical: "speak",
    timer: "speak",
  },
  rituals: {
    morning: { enabled: false, time: "08:00" },
    evening: { enabled: false, time: "22:00" },
    checkIn: { enabled: false, afterHours: 4 },
    weeklyOverview: { enabled: false, time: "18:00" },
    dailyHighlight: { enabled: false, time: "20:00" },
    smallSurprises: { enabled: false },
    welcomeHome: { enabled: false },
    calendarReminders: { enabled: false, minutesBefore: 15 },
  },
  wardrobe: { theme: "gold", seasonal: false, birthday: "10-10" },
  cues: {
    enabled: true,
    volume: 0.7,
    theme: "playful",
    cues: { done: false, touch: true, "listening-start": false },
    quiet: { enabled: true, start: "23:15", end: "06:30" },
  },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture(nodeRed?: NodeRedManagement, withHistory = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-settings-backup-"));
  const filename = path.join(dir, "settings.json");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
  const flowHistory = withHistory
    ? new NodeRedFlowRevisions(config)
    : undefined;
  const store = new SettingsStore(config);
  store.update((next) => {
    next.persona = "Old private persona";
    next.skills = [
      { ...playbook({ name: "Existing private playbook" }), id: "existing" },
    ];
  });
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "fixture",
    timestamp: "fixture",
  }));
  const audit = { record } as unknown as AuditService;
  let lists: Record<string, { id: string; text: string; addedAt: string }[]> =
    {};
  const planning = {
    getListsSnapshot: () => structuredClone(lists),
    replaceLists: (next: typeof lists) => {
      lists = structuredClone(next);
    },
  };
  const backup = new SettingsBackupService(
    store,
    audit,
    planning as never,
    undefined,
    config,
    nodeRed,
    flowHistory,
  );
  const run = (body: unknown = requestBody()) => backup.importLocal(body);
  const bytes = () => fs.readFileSync(filename);
  const assertPrivate = (value: unknown) => {
    const exposed = JSON.stringify(value);
    for (const text of [
      "Private imported persona",
      "Private imported playbook",
      "Private imported instructions",
      "Private note title",
      "Private note contents",
      "Old private persona",
      "Existing private playbook",
    ])
      expect(exposed).not.toContain(text);
  };
  return {
    dir,
    filename,
    journalFile: path.join(dir, "settings-import-transaction.json"),
    store,
    record,
    getLists: () => structuredClone(lists),
    setLists: (next: typeof lists) => {
      lists = structuredClone(next);
    },
    backup,
    flowHistory,
    run,
    bytes,
    assertPrivate,
  };
}

describe("settings backup single-step import", () => {
  it("imports Node-RED flows against the captured revision in one call", async () => {
    let snapshot: NodeRedFlowSnapshot = {
      revision: "rev-1",
      flows: [{ id: "tab-old", type: "tab", label: "Old" }],
    };
    const nodeRed = {
      flowSnapshot: vi.fn(async () => structuredClone(snapshot)),
      writeFlowSnapshot: vi.fn(async (expected: string, flows: unknown) => {
        if (snapshot.revision !== expected)
          return { ok: false, error: "stale" };
        snapshot = {
          revision: "rev-2",
          flows: structuredClone(flows) as Record<string, unknown>[],
        };
        return { ok: true, revision: snapshot.revision };
      }),
    } as unknown as NodeRedManagement;
    const f = fixture(nodeRed, true);
    const body = {
      ...requestBody(),
      data: {
        ...incoming(),
        nodeRedFlows: [{ id: "tab-new", type: "tab", label: "New" }],
      },
    };
    const result = await f.backup.importBackup(body);
    expect(result).toMatchObject({ ok: true, importedFlows: 1 });
    expect(snapshot.flows).toEqual(body.data.nodeRedFlows);
    expect(f.flowHistory?.list().revisions).toHaveLength(2);
    expect(JSON.stringify(f.flowHistory?.list())).not.toContain("Old");
    expect(JSON.stringify(f.flowHistory?.list())).not.toContain("New");
  });

  it("refuses a Node-RED revision that changed after planning without changing local settings", async () => {
    const snapshot: NodeRedFlowSnapshot = {
      revision: "rev-1",
      flows: [{ id: "tab-old", type: "tab", label: "Old" }],
    };
    const flowSnapshot = vi
      .fn(async () => structuredClone(snapshot))
      .mockResolvedValueOnce(structuredClone(snapshot))
      .mockResolvedValue({
        revision: "rev-2",
        flows: [{ id: "tab-other", type: "tab" }],
      });
    const nodeRed = {
      flowSnapshot,
      writeFlowSnapshot: vi.fn(async () => ({ ok: false, error: "stale" })),
    } as unknown as NodeRedManagement;
    const f = fixture(nodeRed);
    const body = {
      ...requestBody(),
      data: {
        ...incoming(),
        nodeRedFlows: [{ id: "tab-new", type: "tab", label: "New" }],
      },
    };
    const before = f.store.get();
    const result = await f.backup.importBackup(body);
    expect(result).toMatchObject({ ok: false });
    expect(f.store.get()).toEqual(before);
    expect(nodeRed.writeFlowSnapshot).not.toHaveBeenCalled();
  });

  it("compensates an interrupted Node-RED import before restoring local stores", async () => {
    const previousFlows = [{ id: "tab-old", type: "tab", label: "Old" }];
    const targetFlows = [{ id: "tab-new", type: "tab", label: "New" }];
    let snapshot: NodeRedFlowSnapshot = {
      revision: "rev-2",
      flows: targetFlows,
    };
    const nodeRed = {
      flowSnapshot: vi.fn(async () => structuredClone(snapshot)),
      writeFlowSnapshot: vi.fn(async (expected: string, flows: unknown) => {
        if (snapshot.revision !== expected) return { ok: false };
        snapshot = {
          revision: "rev-3",
          flows: structuredClone(flows) as Record<string, unknown>[],
        };
        return { ok: true, revision: snapshot.revision };
      }),
    } as unknown as NodeRedManagement;
    const f = fixture(nodeRed);
    const previousSettings = f.store.get();
    const previousLists = f.getLists();
    f.store.update((next) => {
      next.persona = "Partially imported";
    });
    const payload = {
      previousSettings,
      previousLists,
      previousNodeRedFlows: previousFlows,
      targetNodeRedFlows: targetFlows,
      nodeRedRevision: "rev-1",
    };
    fs.writeFileSync(
      f.journalFile,
      JSON.stringify({
        version: 3,
        ...payload,
        digest: crypto
          .createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex"),
      }),
      { mode: 0o600 },
    );

    await f.backup.onModuleInit();

    expect(snapshot.flows).toEqual(previousFlows);
    expect(f.store.get()).toEqual(previousSettings);
    expect(fs.existsSync(f.journalFile)).toBe(false);
  });
  it("restores the entire helper preference configuration in one call", () => {
    const f = fixture();
    expect(
      f.run({
        ...requestBody(),
        data: { ...incoming(), helper: helperChoice, helperPreferences },
      }).ok,
    ).toBe(true);
    expect(f.store.get().helper).toEqual(helperChoice);
    expect(f.store.get().helperPreferences).toEqual(helperPreferences);
  });

  it.each(["merge", "replace"])(
    "preserves existing helper settings when old version-one backups omit them in %s mode",
    (mode) => {
      const f = fixture();
      f.store.update((next) => {
        next.helper = helperChoice;
        next.helperPreferences = structuredClone(helperPreferences);
      });
      expect(f.run({ ...requestBody(), mode }).ok).toBe(true);
      expect(f.store.get().helper).toEqual(helperChoice);
      expect(f.store.get().helperPreferences).toEqual(helperPreferences);
    },
  );

  it("imports in one call, writes a counts-only audit record and keeps private text out of it", () => {
    const f = fixture();
    expect(f.run()).toEqual({
      ok: true,
      imported: 1,
      importedLists: 0,
      importedFlows: 0,
      changedConnections: 0,
      missingSecrets: [],
    });
    expect(f.store.get()).toMatchObject({
      persona: "Private imported persona",
      skills: [
        {
          name: "Private imported playbook",
          instructions: "Private imported instructions",
        },
      ],
      widgets: [{ title: "Private note title", text: "Private note contents" }],
    });
    expect(fs.statSync(f.filename).mode & 0o777).toBe(0o600);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "settings_import",
        confirmation: "direct",
        arguments: expect.objectContaining({
          mode: "replace",
          incomingSkills: 1,
        }),
      }),
    );
    f.assertPrivate(f.record.mock.calls);
  });

  it("exports and restores named lists with merge semantics", () => {
    const f = fixture();
    const bread = {
      id: "11111111",
      text: "brood",
      addedAt: "2026-10-09T10:00:00.000Z",
    };
    f.setLists({ boodschappen: [bread] });
    expect(f.backup.exportLists()).toEqual({ boodschappen: [bread] });
    const data = {
      ...incoming(),
      lists: {
        boodschappen: [
          { id: "22222222", text: "melk", addedAt: "2026-10-10T10:00:00.000Z" },
        ],
        taken: [
          {
            id: "33333333",
            text: "was doen",
            addedAt: "2026-10-10T10:00:00.000Z",
          },
        ],
      },
    };
    expect(f.run({ data, mode: "merge" })).toMatchObject({
      ok: true,
      importedLists: 2,
    });
    expect(f.getLists()).toEqual({
      boodschappen: [bread, ...data.lists.boodschappen],
      taken: data.lists.taken,
    });
  });

  it("restores the prior list snapshot if the settings file cannot be committed", () => {
    const f = fixture();
    const previous = {
      boodschappen: [
        { id: "66666666", text: "koffie", addedAt: "2026-10-10T08:00:00.000Z" },
      ],
    };
    f.setLists(previous);
    vi.spyOn(f.store, "update").mockImplementationOnce(() => {
      expect(fs.statSync(f.journalFile).mode & 0o777).toBe(0o600);
      throw new Error("fixture settings write failure");
    });
    expect(
      f.run({
        ...requestBody(),
        data: {
          ...incoming(),
          lists: {
            boodschappen: [
              {
                id: "77777777",
                text: "thee",
                addedAt: "2026-10-10T09:00:00.000Z",
              },
            ],
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(f.getLists()).toEqual(previous);
    expect(fs.existsSync(f.journalFile)).toBe(false);
  });

  it("recovers the prior settings and lists from a durable journal at startup", async () => {
    const f = fixture();
    const previousSettings = f.store.get();
    f.store.update((next) => {
      next.persona = "Partially imported";
    });
    const previousLists = {
      boodschappen: [
        {
          id: "88888888",
          text: "melk",
          addedAt: "2026-10-10T08:00:00.000Z",
        },
      ],
    };
    f.setLists({
      taken: [
        {
          id: "99999999",
          text: "partial",
          addedAt: "2026-10-10T09:00:00.000Z",
        },
      ],
    });
    const payload = { previousSettings, previousLists };
    fs.writeFileSync(
      f.journalFile,
      JSON.stringify({
        version: 1,
        ...payload,
        digest: crypto
          .createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex"),
      }),
      { mode: 0o600 },
    );

    await f.backup.onModuleInit();

    expect(f.store.get()).toEqual(previousSettings);
    expect(f.getLists()).toEqual(previousLists);
    expect(fs.existsSync(f.journalFile)).toBe(false);
  });

  it("rechecks the store inside update before applying the import", () => {
    const f = fixture();
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementationOnce((callback) => {
      update((next) => {
        next.persona = "Changed just before callback";
      });
      return update(callback);
    });
    expect(f.run()).toMatchObject({ ok: false });
    expect(f.store.get().persona).toBe("Changed just before callback");
  });

  it("audit failure before the write prevents writes", () => {
    const f = fixture();
    const before = f.bytes();
    f.record.mockImplementation(() => {
      throw new Error("fixture audit failure");
    });
    expect(f.run()).toMatchObject({ ok: false });
    expect(f.bytes()).toEqual(before);
  });

  it("reports successful saving honestly if final auditing fails", () => {
    const f = fixture();
    let calls = 0;
    f.record.mockImplementation((entry) => {
      if (++calls === 2) throw new Error("fixture final audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(f.run()).toMatchObject({
      ok: true,
      imported: 1,
      missingSecrets: [],
      auditWarning: expect.any(String),
    });
    expect(f.store.get().persona).toBe("Private imported persona");
  });

  it("does not change saved bytes when writing fails", () => {
    const f = fixture();
    const before = f.bytes();
    vi.spyOn(f.store, "update").mockImplementationOnce(() => {
      throw new Error("fixture write failure");
    });
    expect(f.run()).toMatchObject({ ok: false });
    expect(f.bytes()).toEqual(before);
  });
});

describe("settings backup validation and HTTP boundary", () => {
  it.each([
    { helper: { ...helperChoice, secret: "Bearer helper-extra-secret" } },
    { helper: { mode: "unknown", display: 2 } },
    { helper: { ...helperChoice, display: -1 } },
    { helper: { ...helperChoice, display: "2" } },
    {
      helperPreferences: {
        ...helperPreferences,
        secret: "Bearer preference-extra-secret",
      },
    },
    {
      helperPreferences: {
        ...helperPreferences,
        wardrobe: {
          ...helperPreferences.wardrobe,
          secret: "Bearer wardrobe-extra-secret",
        },
      },
    },
    {
      helperPreferences: {
        ...helperPreferences,
        cues: { ...helperPreferences.cues, extra: "Bearer cue-extra-secret" },
      },
    },
    {
      helperPreferences: {
        ...helperPreferences,
        wardrobe: {
          ...helperPreferences.wardrobe,
          birthday: "Bearer birthday-secret",
        },
      },
    },
  ])(
    "rejects invalid or secret-bearing helper backup fields without saving %j",
    (fields) => {
      const f = fixture();
      const before = f.bytes();
      const body = { ...requestBody(), data: { ...incoming(), ...fields } };
      expect(() => f.run(body)).toThrow(ValidationError);
      expect(f.bytes()).toEqual(before);
      expect(f.record).not.toHaveBeenCalled();
      try {
        f.run(body);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain("Bearer");
      }
    },
  );

  it("exports and imports every helper option without calling the Windows wallpaper, helper or hotkey ports", async () => {
    const displays = vi.fn(async () => ({ ok: true as const, displays: [] }));
    const setWallpaper = vi.fn(async () => ({
      ok: true as const,
      displays: [],
    }));
    const setMode = vi.fn(async () => ({ ok: true as const, displays: [] }));
    const helperSize = vi.fn(async () => ({ ok: true as const }));
    const hotkeys = vi.fn(async () => ({ ok: true }));
    const port: WallpaperPort = {
      configured: true,
      displays,
      setWallpaper,
      setMode,
      helperSize,
      helperPreferences: hotkeys,
    };
    const nova = await createApp({ wallpaper: port });
    nova.store.update((next) => {
      next.helper = helperChoice;
      next.helperPreferences = structuredClone(helperPreferences);
    });
    try {
      const exported = await nova.api.get("/api/settings/export").set(ADMIN);
      expect(exported.body).toMatchObject({
        version: 1,
        helper: helperChoice,
        helperPreferences,
      });
      nova.store.update((next) => {
        next.helper = { mode: "wallpaper", display: 0 };
        next.helperPreferences.contrast = false;
        next.helperPreferences.wardrobe = {
          theme: "nova",
          seasonal: true,
          birthday: "",
        };
      });
      const imported = await nova.api
        .post("/api/settings/import")
        .set(ADMIN)
        .send({ data: exported.body, mode: "replace" });
      expect(imported.status).toBe(200);
      expect(imported.body.ok).toBe(true);
      expect(
        (
          await nova.api
            .post("/api/settings/import/prepare")
            .set(ADMIN)
            .send({})
        ).status,
      ).toBe(404);
      expect(nova.store.get().helper).toEqual(helperChoice);
      expect(nova.store.get().helperPreferences).toEqual(helperPreferences);
      expect(
        (await nova.api.get("/api/settings/helper/preferences")).body,
      ).toEqual(helperPreferences);
      for (const call of [displays, setWallpaper, setMode, helperSize, hotkeys])
        expect(call).not.toHaveBeenCalled();
    } finally {
      await nova.app.close();
    }
  });

  it("projects only known wardrobe fields from legacy GET, PUT and export without revealing unknown secret extras", async () => {
    const nova = await createApp();
    const secret = "Bearer legacy-wardrobe-secret";
    const legacyPreferences = {
      ...helperPreferences,
      wardrobe: { ...helperPreferences.wardrobe!, privateExtra: secret },
    };
    nova.store.update((next) => {
      next.helperPreferences = legacyPreferences;
    });
    try {
      const current = await nova.api.get("/api/settings/helper/preferences");
      const exported = await nova.api.get("/api/settings/export").set(ADMIN);
      expect(current.body).toEqual(helperPreferences);
      expect(exported.body.helperPreferences).toEqual(helperPreferences);
      expect(JSON.stringify([current.body, exported.body])).not.toContain(
        secret,
      );
      const saved = await nova.api
        .put("/api/settings/helper/preferences")
        .set(ADMIN)
        .send(legacyPreferences);
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual(helperPreferences);
      expect(JSON.stringify(saved.body)).not.toContain(secret);
      expect(nova.store.get().helperPreferences).toEqual(helperPreferences);
    } finally {
      await nova.app.close();
    }
  });

  it("rejects visible credential copies in HTTP import with unchanged bytes and no public or audit leaks", async () => {
    const nova = await createApp();
    const filename = nova.app.get(NovaConfig).dataFile("settings.json");
    nova.store.update((next) => {
      next.persona = "Existing safe persona";
      next.skills = [];
      next.widgets = [];
      next.quickActions = null;
      next.toolOverrides = {};
      next.sidebar = null;
    });
    nova.audits.length = 0;
    const before = fs.readFileSync(filename);
    const copiedSecret = "shared-fixture-private-value";
    const privateWebhook = webhook({
      http: {
        ...webhook().http,
        body: copiedSecret,
        secretHeaders: [{ name: "X-Fixture", value: copiedSecret }],
      },
    });
    const cases = [
      {
        secret: "Bearer preview-persona-value",
        data: { ...incoming(), persona: "Bearer preview-persona-value" },
      },
      {
        secret: "sk-previewabcdefghijklmno",
        data: {
          ...incoming(),
          widgets: [
            {
              type: "note",
              title: "Safe title",
              text: "sk-previewabcdefghijklmno",
              enabled: true,
            },
          ],
        },
      },
      {
        secret: "Bearer preview-skill-value",
        data: {
          ...incoming(),
          skills: [playbook({ name: "Bearer preview-skill-value" })],
        },
      },
      {
        secret: "Bearer preview-header-value",
        data: {
          ...incoming(),
          skills: [
            webhook({
              http: {
                ...webhook().http,
                headers: [
                  { name: "X-Fixture", value: "Bearer preview-header-value" },
                ],
                secretHeaders: [],
              },
            }),
          ],
        },
      },
      {
        secret: "password=preview-action-value",
        data: {
          ...incoming(),
          quickActions: [
            { label: "Safe action", prompt: "password=preview-action-value" },
          ],
        },
      },
      {
        secret: "Bearer preview-tool-value",
        data: {
          ...incoming(),
          toolOverrides: { echo: { description: "Bearer preview-tool-value" } },
        },
      },
      {
        secret: copiedSecret,
        data: { ...incoming(), skills: [privateWebhook] },
      },
    ];
    try {
      for (const { data, secret } of cases) {
        const preview = await nova.api
          .post("/api/settings/import")
          .set(ADMIN)
          .send({ data, mode: "replace" });
        expect(preview.status).toBe(400);
        expect(JSON.stringify(preview.body)).not.toContain(secret);
        expect(fs.readFileSync(filename)).toEqual(before);
        const exported = await nova.api.get("/api/settings/export").set(ADMIN);
        const publicSettings = await nova.api.get("/api/settings/public");
        const overview = await nova.api.get("/api/settings").set(ADMIN);
        expect(
          JSON.stringify([
            exported.body,
            publicSettings.body,
            overview.body,
            nova.audits,
          ]),
        ).not.toContain(secret);
        expect(fs.readFileSync(filename)).toEqual(before);
      }
    } finally {
      await nova.app.close();
    }
  });

  it("rejects a known existing private header value copied into visible imported text", () => {
    const f = fixture();
    const secret = "existing-fixture-private-value";
    f.store.update((next) => {
      next.skills = [
        {
          ...webhook({
            http: {
              ...webhook().http,
              secretHeaders: [{ name: "X-Fixture", value: secret }],
            },
          }),
          id: "garagedeur",
        },
      ];
    });
    const before = f.bytes();
    expect(() =>
      f.run({
        ...requestBody(),
        data: { ...incoming(), persona: `Visible copy ${secret}` },
      }),
    ).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { ...requestBody(), acknowledgeEffects: true },
    { ...requestBody(), always: true },
    { ...requestBody(), mode: "unknown" },
    { ...requestBody(), data: { ...incoming(), version: 2 } },
    { ...requestBody(), data: { ...incoming(), format: "other" } },
    { ...requestBody(), data: { ...incoming(), standingApprovals: [] } },
    { ...requestBody(), data: { ...incoming(), skills: "wrong" } },
    {
      ...requestBody(),
      data: { ...incoming(), widgets: [{ type: "unknown" }] },
    },
  ])("rejects invalid imports without changing bytes: %j", (body) => {
    const f = fixture();
    const before = f.bytes();
    expect(() => f.run(body)).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
  });

  it("rejects imports over one megabyte before storing a candidate", () => {
    const f = fixture();
    const before = f.bytes();
    expect(() =>
      f.run({
        ...requestBody(),
        data: { ...incoming(), persona: "🌻".repeat(250001) },
      }),
    ).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
  });

  it("reports only missing secret declarations and keeps incoming webhook secrets out of the audit log", () => {
    const f = fixture();
    const secret = "fixture-incoming-private-header";
    const payload = {
      ...incoming(),
      skills: [
        webhook({
          http: {
            ...webhook().http,
            secretHeaders: [{ name: "X-Fixture", value: secret }],
          },
        }),
      ],
    };
    const result = f.run({ ...requestBody(), data: payload });
    expect(result).toMatchObject({
      ok: true,
      missingSecrets: [{ skill: "Garagedeur", headers: ["X-Fixture"] }],
    });
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(f.store.get())).not.toContain(secret);
  });
});
