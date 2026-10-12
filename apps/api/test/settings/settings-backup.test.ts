import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperPreferences } from "@nova/contracts";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
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
  acknowledgeEffects: true,
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

function fixture(nodeRed?: NodeRedManagement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-settings-backup-"));
  const filename = path.join(dir, "settings.json");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
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
  const confirmations = new ConfirmationsService(audit);
  let lists: Record<string, { id: string; text: string; addedAt: string }[]> =
    {};
  const planning = {
    getListsSnapshot: () => structuredClone(lists),
    replaceLists: (next: typeof lists) => {
      lists = structuredClone(next);
    },
  };
  let now = 1000;
  confirmations.now = () => now;
  const backup = new SettingsBackupService(
    store,
    confirmations,
    audit,
    planning as never,
    undefined,
    config,
    nodeRed,
  );
  cleanups.push(() => backup.onModuleDestroy());
  const prepare = (body: unknown = requestBody()) => {
    const prepared = backup.prepare(body);
    expect(prepared.ok).toBe(true);
    if (!prepared.action) throw new Error("Missing fixture import approval");
    return prepared;
  };
  const confirm = (prepared: ReturnType<typeof prepare>, approve = true) =>
    backup.confirm({
      sessionId: prepared.action!.sessionId,
      confirmationId: prepared.action!.confirmationId,
      approve,
    });
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
    confirmations,
    getLists: () => structuredClone(lists),
    setLists: (next: typeof lists) => {
      lists = structuredClone(next);
    },
    backup,
    prepare,
    confirm,
    bytes,
    assertPrivate,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("settings backup private approvals", () => {
  it("previews and imports Node-RED flows against the captured revision", async () => {
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
    const f = fixture(nodeRed);
    const body = {
      ...requestBody(),
      data: {
        ...incoming(),
        nodeRedFlows: [{ id: "tab-new", type: "tab", label: "New" }],
      },
    };
    const prepared = f.backup.prepareWithNodeRed(body, snapshot);
    expect(prepared.summary).toMatchObject({
      nodeRedFlowsChanged: true,
      incomingFlows: 1,
      totalFlows: 1,
      removedFlows: 1,
    });
    const result = await f.backup.confirmWithNodeRed({
      sessionId: prepared.action.sessionId,
      confirmationId: prepared.action.confirmationId,
      approve: true,
    });
    expect(result).toMatchObject({ ok: true, importedFlows: 1 });
    expect(snapshot.flows).toEqual(body.data.nodeRedFlows);
  });

  it("refuses stale Node-RED revisions without changing local settings", async () => {
    let snapshot: NodeRedFlowSnapshot = {
      revision: "rev-1",
      flows: [{ id: "tab-old", type: "tab", label: "Old" }],
    };
    const nodeRed = {
      flowSnapshot: vi.fn(async () => structuredClone(snapshot)),
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
    const prepared = f.backup.prepareWithNodeRed(body, snapshot);
    snapshot = { revision: "rev-2", flows: [{ id: "tab-other", type: "tab" }] };
    const before = f.store.get();
    const result = await f.backup.confirmWithNodeRed({
      sessionId: prepared.action.sessionId,
      confirmationId: prepared.action.confirmationId,
      approve: true,
    });
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
  it("previews helper changes without writes and restores the entire preference configuration after confirmation", () => {
    const f = fixture();
    const before = f.bytes();
    const prepared = f.prepare({
      ...requestBody(),
      data: { ...incoming(), helper: helperChoice, helperPreferences },
    });
    expect(prepared.summary).toMatchObject({
      helperChanged: true,
      helperPreferencesChanged: true,
    });
    expect(f.bytes()).toEqual(before);
    expect(prepared.action!.args).not.toHaveProperty("helper");
    expect(prepared.action!.args).not.toHaveProperty("helperPreferences");
    expect(f.confirm(prepared).ok).toBe(true);
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
      const prepared = f.prepare({ ...requestBody(), mode });
      expect(prepared.summary).toMatchObject({
        helperChanged: false,
        helperPreferencesChanged: false,
      });
      expect(f.confirm(prepared).ok).toBe(true);
      expect(f.store.get().helper).toEqual(helperChoice);
      expect(f.store.get().helperPreferences).toEqual(helperPreferences);
    },
  );

  it.each(["helper", "preferences"])(
    "rejects stale confirmation after %s changes without restoring its earlier configuration",
    (field) => {
      const f = fixture();
      const prepared = f.prepare({
        ...requestBody(),
        data: { ...incoming(), helper: helperChoice, helperPreferences },
      });
      f.store.update((next) => {
        if (field === "helper") next.helper.mode = "helper";
        else next.helperPreferences.cues.volume = 0.25;
      });
      const changedBytes = f.bytes();
      expect(f.confirm(prepared)).toMatchObject({ ok: false });
      expect(f.bytes()).toEqual(changedBytes);
    },
  );

  it("prepares counts-only dangerous 60-second session-bound approvals without writing or leaking the private candidate", () => {
    const f = fixture();
    const before = f.bytes();
    const first = f.prepare();
    const second = f.prepare();
    expect(first.summary).toMatchObject({
      mode: "replace",
      incomingSkills: 1,
      incomingWidgets: 1,
      removedSkills: 1,
      totalSkills: 1,
      totalWidgets: 1,
      incomingLists: 0,
      totalLists: 0,
      removedLists: 0,
      changedConnections: 0,
    });
    expect(first.action).toMatchObject({
      tool: "settings_import",
      risk: "DANGEROUS",
      allowAlways: false,
      createdAt: 1000,
      expiresAt: 61000,
      args: {
        mode: "replace",
        incomingSkills: 1,
        incomingWidgets: 1,
        incomingLists: 0,
        totalLists: 0,
        removedLists: 0,
        changedConnections: 0,
        modelRolesChanged: false,
        removedSkills: 1,
        removedWidgets: 0,
      },
    });
    expect(Object.keys(first.action!.args).sort()).toEqual([
      "changedConnections",
      "incomingLists",
      "incomingSkills",
      "incomingWidgets",
      "mode",
      "modelRolesChanged",
      "removedLists",
      "removedSkills",
      "removedWidgets",
      "totalLists",
    ]);
    expect(first.action!.sessionId).toMatch(/^settings-import:/);
    expect(first.action!.sessionId).not.toBe(second.action!.sessionId);
    expect(first.action!.confirmationId).not.toBe(
      second.action!.confirmationId,
    );
    expect(f.bytes()).toEqual(before);
    f.assertPrivate([
      first,
      second,
      f.record.mock.calls,
      f.confirmations.peek(first.action!.sessionId),
    ]);
  });

  it("stores the frozen private candidate once, even if request and returned metadata change", () => {
    const f = fixture();
    const body = requestBody();
    const prepared = f.prepare(body);
    body.data.persona = "Mutated after prepare";
    body.data.skills[0]!.instructions = "Mutated instructions";
    prepared.action!.args.mode = "merge";
    expect(f.confirm(prepared)).toEqual({
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
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
    f.assertPrivate(f.record.mock.calls);
  });

  it("exports and restores named lists with merge semantics and explicit preview counts", () => {
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
    const prepared = f.prepare({
      data,
      mode: "merge",
      acknowledgeEffects: true,
    });
    expect(prepared.summary).toMatchObject({
      incomingLists: 2,
      totalLists: 2,
      removedLists: 0,
      listsChanged: true,
    });
    expect(f.confirm(prepared)).toMatchObject({ ok: true, importedLists: 2 });
    expect(f.getLists()).toEqual({
      boodschappen: [bread, ...data.lists.boodschappen],
      taken: data.lists.taken,
    });
  });

  it("rejects list changes made after preview before consuming the import", () => {
    const f = fixture();
    const prepared = f.prepare({
      ...requestBody(),
      data: {
        ...incoming(),
        lists: {
          boodschappen: [
            {
              id: "44444444",
              text: "kaas",
              addedAt: "2026-10-10T10:00:00.000Z",
            },
          ],
        },
      },
    });
    f.setLists({
      taken: [
        {
          id: "55555555",
          text: "afspraak",
          addedAt: "2026-10-10T11:00:00.000Z",
        },
      ],
    });
    expect(f.confirm(prepared)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Instellingen zijn intussen gewijzigd"),
    });
    expect(f.getLists()).toHaveProperty("taken");
  });

  it("restores the prior list snapshot if the settings file cannot be committed", () => {
    const f = fixture();
    const previous = {
      boodschappen: [
        { id: "66666666", text: "koffie", addedAt: "2026-10-10T08:00:00.000Z" },
      ],
    };
    f.setLists(previous);
    const prepared = f.prepare({
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
    });
    vi.spyOn(f.store, "update").mockImplementationOnce(() => {
      expect(fs.statSync(f.journalFile).mode & 0o777).toBe(0o600);
      throw new Error("fixture settings write failure");
    });
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
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

  it("rejects cross-session and wrong IDs without consuming matching consent", () => {
    const f = fixture();
    const first = f.prepare();
    const second = f.prepare();
    const before = f.bytes();
    expect(
      f.backup.confirm({
        sessionId: second.action!.sessionId,
        confirmationId: first.action!.confirmationId,
        approve: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      f.backup.confirm({
        sessionId: first.action!.sessionId,
        confirmationId: crypto.randomUUID(),
        approve: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      f.backup.confirm({
        sessionId: `settings-import:${crypto.randomUUID()}`,
        confirmationId: first.action!.confirmationId,
        approve: true,
      }),
    ).toMatchObject({ ok: false });
    expect(f.confirmations.has(first.action!.sessionId)).toBe(true);
    expect(f.bytes()).toEqual(before);
  });

  it("cancels and consumes consent without saving private payload", () => {
    const f = fixture();
    const before = f.bytes();
    const prepared = f.prepare();
    expect(f.confirm(prepared, false)).toEqual({
      ok: true,
      cancelled: true,
      imported: 0,
      importedLists: 0,
      importedFlows: 0,
      changedConnections: 0,
      missingSecrets: [],
    });
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
    expect(f.bytes()).toEqual(before);
    f.assertPrivate(f.record.mock.calls);
  });

  it.each([59999, 60000, 60001])(
    "enforces sixty-second single-use expiry at %i ms",
    (elapsed) => {
      const f = fixture();
      const before = f.bytes();
      const prepared = f.prepare();
      f.advance(elapsed);
      expect(f.confirm(prepared).ok).toBe(elapsed < 60000);
      if (elapsed >= 60000) expect(f.bytes()).toEqual(before);
      expect(f.confirm(prepared)).toMatchObject({ ok: false });
    },
  );

  it.each(["persona", "helper", "standing-approval", "skill", "preferences"])(
    "invalidates candidates on whole-store %s drift",
    (change) => {
      const f = fixture();
      const prepared = f.prepare();
      f.store.update((next) => {
        if (change === "persona") next.persona = "Changed";
        if (change === "helper") next.helper.display = 2;
        if (change === "standing-approval")
          next.standingApprovals = [
            {
              id: "existing-grant",
              tool: "echo",
              argsHash: "a",
              schemaHash: "b",
              createdAt: 1,
            },
          ];
        if (change === "skill") next.skills[0]!.instructions = "Changed";
        if (change === "preferences") next.helperPreferences.contrast = true;
      });
      const changedBytes = f.bytes();
      expect(f.confirm(prepared)).toMatchObject({ ok: false });
      expect(f.bytes()).toEqual(changedBytes);
      expect(f.confirm(prepared)).toMatchObject({ ok: false });
    },
  );

  it("rechecks the store inside update before applying the candidate", () => {
    const f = fixture();
    const prepared = f.prepare();
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementationOnce((callback) => {
      update((next) => {
        next.persona = "Changed just before callback";
      });
      return update(callback);
    });
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
    expect(f.store.get().persona).toBe("Changed just before callback");
  });

  it.each(["prepare", "approved_admin_ui"])(
    "audit failure at %s prevents writes",
    (phase) => {
      const f = fixture();
      const before = f.bytes();
      const prepared = phase === "approved_admin_ui" ? f.prepare() : undefined;
      f.record.mockImplementation((entry) => {
        if (phase === "prepare" || entry.confirmation === phase)
          throw new Error("fixture audit failure");
        return { ...entry, id: "fixture", timestamp: "fixture" };
      });
      if (prepared) expect(f.confirm(prepared)).toMatchObject({ ok: false });
      else expect(() => f.prepare()).toThrow("fixture audit failure");
      expect(f.bytes()).toEqual(before);
    },
  );

  it("reports successful saving honestly if final auditing fails", () => {
    const f = fixture();
    const prepared = f.prepare();
    f.record.mockImplementation((entry) => {
      if (entry.confirmation === "confirmed_admin_ui")
        throw new Error("fixture final audit failure");
      return { ...entry, id: "fixture", timestamp: "fixture" };
    });
    expect(f.confirm(prepared)).toMatchObject({
      ok: true,
      imported: 1,
      missingSecrets: [],
      auditWarning: expect.any(String),
    });
    expect(f.store.get().persona).toBe("Private imported persona");
  });

  it("does not change saved bytes when writing fails and consumes the candidate", () => {
    const f = fixture();
    const prepared = f.prepare();
    const before = f.bytes();
    vi.spyOn(f.store, "update").mockImplementationOnce(() => {
      throw new Error("fixture write failure");
    });
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
    expect(f.bytes()).toEqual(before);
    expect(f.confirm(prepared)).toMatchObject({ ok: false });
  });

  it("allows only one of overlapping candidates against the same store revision", () => {
    const f = fixture();
    const first = f.prepare();
    const second = f.prepare({
      ...requestBody(),
      data: { ...incoming(), persona: "Second candidate" },
    });
    expect(f.confirm(first).ok).toBe(true);
    expect(f.confirm(second)).toMatchObject({ ok: false });
    expect(f.store.get().persona).toBe("Private imported persona");
  });

  it("bounds twenty private candidates, frees cancellation and erases content autonomously at sixty seconds", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const state = f.backup as unknown as {
      drafts: Map<string, unknown>;
      timers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const prepared = Array.from({ length: 20 }, () => f.prepare());
    expect(state.drafts.size).toBe(20);
    expect(() => f.prepare()).toThrow(ValidationError);
    f.confirm(prepared[0]!, false);
    f.prepare();
    expect(state.drafts.size).toBe(20);
    f.advance(59999);
    vi.advanceTimersByTime(59999);
    expect(state.drafts.size).toBe(20);
    f.advance(1);
    vi.advanceTimersByTime(1);
    expect(state.drafts.size).toBe(0);
    expect(state.timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.assertPrivate(f.confirmations.peek(prepared[1]!.action!.sessionId));
    expect(f.confirm(prepared[1]!)).toMatchObject({ ok: false });
    f.prepare();
    f.backup.onModuleDestroy();
    expect(state.drafts.size).toBe(0);
    expect(state.timers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
      expect(() => f.backup.prepare(body)).toThrow(ValidationError);
      expect(f.bytes()).toEqual(before);
      expect(f.record).not.toHaveBeenCalled();
      try {
        f.backup.prepare(body);
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
    const filename = nova.app.get(NovaConfig).dataFile("settings.json");
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
      const before = fs.readFileSync(filename);
      const preview = await nova.api
        .post("/api/settings/import/prepare")
        .set(ADMIN)
        .send({
          data: exported.body,
          mode: "replace",
          acknowledgeEffects: true,
        });
      expect(preview.status).toBe(200);
      expect(preview.body.summary).toMatchObject({
        helperChanged: true,
        helperPreferencesChanged: true,
      });
      expect(fs.readFileSync(filename)).toEqual(before);
      const { sessionId, confirmationId } = preview.body.action;
      expect(
        (
          await nova.api
            .post("/api/settings/import")
            .set(ADMIN)
            .send({ sessionId, confirmationId, approve: true })
        ).body.ok,
      ).toBe(true);
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

  it("rejects visible credential copies in HTTP preview with unchanged bytes and no public or audit leaks", async () => {
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
          .post("/api/settings/import/prepare")
          .set(ADMIN)
          .send({ data, mode: "replace", acknowledgeEffects: true });
        expect(preview.status).toBe(400);
        expect(preview.body).not.toHaveProperty("action");
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
      f.backup.prepare({
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
    { ...requestBody(), acknowledgeEffects: false },
    { ...requestBody(), acknowledgeEffects: "true" },
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
    expect(() => f.backup.prepare(body)).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
  });

  it("rejects imports over one megabyte before storing a candidate", () => {
    const f = fixture();
    const before = f.bytes();
    expect(() =>
      f.backup.prepare({
        ...requestBody(),
        data: { ...incoming(), persona: "🌻".repeat(250001) },
      }),
    ).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
    expect(f.record).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    requestBody(),
    {
      sessionId: "chat-session",
      confirmationId: crypto.randomUUID(),
      approve: true,
    },
    {
      sessionId: `settings-import:${crypto.randomUUID()}`,
      confirmationId: "invalid",
      approve: true,
    },
    {
      sessionId: `settings-import:${crypto.randomUUID()}`,
      confirmationId: crypto.randomUUID(),
      approve: true,
      data: incoming(),
    },
    {
      sessionId: `settings-import:${crypto.randomUUID()}`,
      confirmationId: crypto.randomUUID(),
      approve: true,
      always: true,
    },
  ])("rejects legacy payloads and invalid confirmation shapes %j", (body) => {
    const f = fixture();
    const before = f.bytes();
    expect(() => f.backup.confirm(body)).toThrow(ValidationError);
    expect(f.bytes()).toEqual(before);
  });

  it("requires PIN and admin on preparation and confirmation, rejects direct bypass and saves only after confirmed HTTP approval", async () => {
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    const headers = { ...ADMIN, "x-nova-pin": "4321" };
    const filename = nova.app.get(NovaConfig).dataFile("settings.json");
    nova.store.update((next) => {
      next.persona = "HTTP existing persona";
    });
    const before = fs.readFileSync(filename);
    try {
      for (const [route, body] of [
        ["/import/prepare", requestBody()],
        [
          "/import",
          {
            sessionId: `settings-import:${crypto.randomUUID()}`,
            confirmationId: crypto.randomUUID(),
            approve: true,
          },
        ],
      ] as const) {
        expect(
          (await nova.api.post(`/api/settings${route}`).set(ADMIN).send(body))
            .status,
        ).toBe(401);
        expect(
          (
            await nova.api
              .post(`/api/settings${route}`)
              .set(ADMIN)
              .set("x-nova-pin", "wrong")
              .send(body)
          ).status,
        ).toBe(401);
        expect(
          (
            await nova.api
              .post(`/api/settings${route}`)
              .set("x-nova-pin", "4321")
              .send(body)
          ).status,
        ).toBe(403);
      }
      expect(
        (
          await nova.api
            .post("/api/settings/import")
            .set(headers)
            .send(requestBody())
        ).status,
      ).toBe(400);
      expect(fs.readFileSync(filename)).toEqual(before);
      const prepared = await nova.api
        .post("/api/settings/import/prepare")
        .set(headers)
        .send(requestBody());
      expect(prepared.status).toBe(200);
      expect(prepared.body.summary).toMatchObject({
        incomingSkills: 1,
        incomingWidgets: 1,
      });
      expect(fs.readFileSync(filename)).toEqual(before);
      expect(JSON.stringify(prepared.body)).not.toContain(
        "Private imported instructions",
      );
      const { sessionId, confirmationId } = prepared.body.action;
      expect(
        (
          await nova.api
            .post("/api/settings/import")
            .set(headers)
            .send({ sessionId, confirmationId, approve: true })
        ).body,
      ).toMatchObject({ ok: true, imported: 1 });
      expect(nova.store.get().persona).toBe("Private imported persona");
      expect(
        (
          await nova.api
            .post("/api/settings/import")
            .set(headers)
            .send({ sessionId, confirmationId, approve: true })
        ).body,
      ).toMatchObject({ ok: false });
    } finally {
      await nova.app.close();
    }
  });

  it("reports only missing secret declarations and keeps incoming webhook payload private until approval", () => {
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
    const before = f.bytes();
    const prepared = f.prepare({ ...requestBody(), data: payload });
    expect(prepared.summary?.missingSecrets).toEqual([
      { skill: "Garagedeur", headers: ["X-Fixture"] },
    ]);
    expect(JSON.stringify([prepared, f.record.mock.calls])).not.toContain(
      secret,
    );
    expect(JSON.stringify(prepared.action)).not.toContain("Garagedeur");
    expect(f.bytes()).toEqual(before);
    expect(f.confirm(prepared)).toMatchObject({
      ok: true,
      missingSecrets: [{ skill: "Garagedeur", headers: ["X-Fixture"] }],
    });
    expect(JSON.stringify(f.store.get())).not.toContain(secret);
  });
});
