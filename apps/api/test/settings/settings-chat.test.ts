import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { normalizeSkill } from "../../src/settings/skills/skills.js";
import { approvalHash } from "../../src/tools/tools.service.js";
import {
  ADMIN,
  createApp,
  playbook,
  type TestApp,
  webhook,
} from "./helpers.js";

let nova: TestApp;
let confirmations: ConfirmationsService;
let sessionNumber = 0;
const session = () => `settings-chat-${++sessionNumber}`;
const instructionArgs = {
  name: "Ochtend",
  instructions: "Dim de lampen en zet de televisie aan.",
  description: "Sfeer voor een filmavond",
  examples: ["start filmavond"],
};
const mutations = [
  ["settings_persona_set", { text: "Antwoord kort." }],
  ["settings_instruction_create", instructionArgs],
  ["settings_skill_toggle", { id: "filmavond", enabled: false }],
] as const;

beforeAll(async () => {
  nova = await createApp({
    env: { JARVIS_ENABLE_ACTIONS: "false", JARVIS_EXTENSIONS: "false" },
    llm: {
      complete: async () => {
        throw new Error("Unexpected LLM call");
      },
    },
  });
  confirmations = nova.app.get(ConfirmationsService);
});
afterAll(() => nova.app.close());
beforeEach(() => {
  fs.rmSync(path.join(process.env.NOVA_DATA_DIR!, "settings.json"), {
    force: true,
  });
  nova.store.reset();
  nova.store.update((next) => {
    next.skills = [normalizeSkill(playbook()) as never];
  });
  nova.audits.length = 0;
});

async function approve(
  name: string,
  args: Record<string, unknown>,
  always = false,
) {
  const id = session();
  const pending = await nova.tools.execute(name, args, id);
  expect(pending).toMatchObject({
    ok: false,
    requiresConfirmation: true,
    action: { tool: name, risk: "CONFIRM", sessionId: id, allowAlways: false },
  });
  const approval = confirmations.take(id, pending.action!.confirmationId)!;
  expect(approval).not.toBeNull();
  return nova.tools.execute(name, approval.args, id, approval, always);
}

function settingsBytes() {
  return fs.readFileSync(
    path.join(process.env.NOVA_DATA_DIR!, "settings.json"),
    "utf8",
  );
}

describe("personal settings through the actual tool confirmation pipeline", () => {
  it("offers exactly four personal settings tools with actions and extensions disabled", () => {
    expect(
      nova.tools.list().filter((tool) => tool.source === "settings"),
    ).toEqual([
      expect.objectContaining({
        name: "settings_skills",
        risk: "READ_ONLY",
        enabled: true,
      }),
      ...mutations.map(([name]) =>
        expect.objectContaining({ name, risk: "CONFIRM", enabled: true }),
      ),
    ]);
    expect(nova.tools.forModel().map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining([
        "settings_skills",
        ...mutations.map(([name]) => name),
      ]),
    );
    expect(
      nova.tools.list().find((tool) => tool.name === "echo")?.enabled,
    ).toBe(false);
  });

  it.each(mutations)(
    "%s always requests fresh confirmation and writes nothing first",
    async (name, args) => {
      const before = settingsBytes();
      const id = session();
      const first = await nova.tools.execute(name, args, id);
      const second = await nova.tools.execute(name, args, id);
      for (const pending of [first, second])
        expect(pending).toMatchObject({
          ok: false,
          requiresConfirmation: true,
          action: { risk: "CONFIRM", allowAlways: false },
        });
      expect(second.action!.confirmationId).not.toBe(
        first.action!.confirmationId,
      );
      expect(confirmations.take(id, first.action!.confirmationId)).toBeNull();
      expect(settingsBytes()).toBe(before);
      expect(nova.audits.some((row) => row.tool === "settings_change")).toBe(
        false,
      );
    },
  );

  it("takes confirmations once, binds their ID/session, and expires at exactly 60 seconds", async () => {
    const id = session();
    const pending = await nova.tools.execute(
      "settings_persona_set",
      { text: "Kort." },
      id,
    );
    const action = pending.action!;
    expect(action.expiresAt - action.createdAt).toBe(60_000);
    expect(confirmations.take(session(), action.confirmationId)).toBeNull();
    expect(confirmations.take(id, "wrong-id")).toBeNull();
    expect(confirmations.peek(id)).toEqual(action);
    expect(confirmations.take(id, action.confirmationId)).toEqual(action);
    expect(confirmations.take(id, action.confirmationId)).toBeNull();

    const expiring = await nova.tools.execute(
      "settings_persona_set",
      { text: "Kort." },
      id,
    );
    const now = confirmations.now;
    confirmations.now = () => expiring.action!.expiresAt;
    try {
      expect(
        confirmations.take(id, expiring.action!.confirmationId),
      ).toBeNull();
      expect(confirmations.take(id)).toBeNull();
    } finally {
      confirmations.now = now;
    }
    expect(nova.store.get().persona).toBe("");
    expect(nova.audits).toContainEqual(
      expect.objectContaining({ sessionId: id, confirmation: "expired" }),
    );
  });

  it.each(["args", "session", "expired", "tool"])(
    "rejects a mismatched %s approval without writing or granting",
    async (mismatch) => {
      const id = session();
      const pending = await nova.tools.execute(
        "settings_persona_set",
        { text: "Kort." },
        id,
      );
      const approval = confirmations.take(id, pending.action!.confirmationId)!;
      const before = settingsBytes();
      const result = await nova.tools.execute(
        "settings_persona_set",
        mismatch === "args" ? { text: "Anders." } : approval.args,
        mismatch === "session" ? session() : id,
        mismatch === "expired"
          ? { ...approval, expiresAt: Date.now() - 1 }
          : mismatch === "tool"
            ? { ...approval, tool: "settings_instruction_create" }
            : approval,
        true,
      );
      expect(result.requiresConfirmation).toBe(true);
      expect(settingsBytes()).toBe(before);
      expect(nova.store.get().standingApprovals).toEqual([]);
    },
  );

  it("sets and clears persona, creates an instruction, and toggles it with mutation and execution audits", async () => {
    expect(
      await approve("settings_persona_set", { text: "  Houd het kort.  " }),
    ).toMatchObject({ ok: true, verified: true });
    expect(nova.store.get().persona).toBe("Houd het kort.");
    expect(await approve("settings_persona_set", { text: "" })).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(nova.store.get().persona).toBe("");
    expect(
      await approve("settings_instruction_create", {
        ...instructionArgs,
        name: "Ochtend",
      }),
    ).toMatchObject({ ok: true, verified: true });
    const created = nova.store
      .get()
      .skills.find((skill) => skill.id === "ochtend")!;
    expect(created).toMatchObject({
      type: "instruction",
      enabled: true,
      version: 1,
    });
    expect(created).not.toHaveProperty("http");
    expect(
      await approve("settings_skill_toggle", { id: "ochtend", enabled: false }),
    ).toMatchObject({ ok: true, verified: true });
    expect(
      nova.store.get().skills.find((skill) => skill.id === "ochtend"),
    ).toMatchObject({ enabled: false, version: 2 });
    const changes = nova.audits.filter((row) => row.tool === "settings_change");
    expect(
      changes.map((row) => (row.arguments as { what?: string })?.what),
    ).toEqual(["persona", "persona", "skill-created", "skill-updated"]);
    for (const change of changes) {
      expect(change).toMatchObject({
        risk: "CONFIRM",
        confirmation: "confirmed_tool",
        result: { ok: true },
      });
      expect(nova.audits).toContainEqual(
        expect.objectContaining({
          sessionId: change.sessionId,
          confirmation: "confirmed",
          phase: "execution_started",
        }),
      );
    }
  });

  it.each(mutations)(
    "%s never creates a grant when explicitly approved with Always",
    async (name, args) => {
      expect(await approve(name, args, true)).toMatchObject({ ok: true });
      expect(nova.store.get().standingApprovals).toEqual([]);
      expect(
        nova.audits.some(
          (row) => row.confirmation === "standing_approval_created",
        ),
      ).toBe(false);
    },
  );

  it.each(mutations)(
    "%s ignores explicit Always and forged standing grants",
    async (name, args) => {
      const id = session();
      const pending = await nova.tools.execute(name, args, id);
      const approval = confirmations.take(id, pending.action!.confirmationId)!;
      nova.store.update((next) => {
        next.standingApprovals.push({
          id: "forged",
          tool: name,
          argsHash: approvalHash(approval.args),
          schemaHash: approval.schemaFingerprint!,
          createdAt: Date.now(),
        });
      });
      const before = settingsBytes();
      expect(await nova.tools.execute(name, args, session())).toMatchObject({
        requiresConfirmation: true,
      });
      expect(settingsBytes()).toBe(before);
      expect(
        await nova.tools.execute(name, approval.args, id, approval, true),
      ).toMatchObject({ ok: true });
      expect(nova.store.get().standingApprovals).toHaveLength(1);
      expect(
        nova.audits.some(
          (row) =>
            row.confirmation === "standing_approval_created" ||
            row.confirmation === "standing_approval",
        ),
      ).toBe(false);
      expect(
        (await nova.tools.execute(name, args, session())).requiresConfirmation,
      ).toBe(true);
    },
  );

  it.each(["persona", "skills"])(
    "requires a new confirmation after the settings screen changes %s",
    async (field) => {
      const id = session();
      const pending = await nova.tools.execute(
        "settings_persona_set",
        { text: "Chat rules." },
        id,
      );
      const approval = confirmations.take(id, pending.action!.confirmationId)!;
      const response =
        field === "persona"
          ? await nova.api
              .put("/api/settings/persona")
              .set(ADMIN)
              .send({ text: "Screen rules." })
          : await nova.api
              .post("/api/settings/skills")
              .set(ADMIN)
              .send(playbook({ name: "Ochtend" }));
      expect(response.status).toBeLessThan(300);
      const before = settingsBytes();
      const renewed = await nova.tools.execute(
        "settings_persona_set",
        approval.args,
        id,
        approval,
        true,
      );
      expect(renewed.requiresConfirmation).toBe(true);
      expect(renewed.action!.schemaFingerprint).not.toBe(
        approval.schemaFingerprint,
      );
      expect(settingsBytes()).toBe(before);
      expect(nova.store.get().standingApprovals).toEqual([]);
    },
  );
});

describe("settings chat cannot change integrations or persist invalid personal changes", () => {
  it("has no setters for services, credentials, MCP, HTTP bindings or webhooks", async () => {
    const names = nova.tools
      .forModel()
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith("settings_"));
    expect(names.sort()).toEqual([
      "settings_instruction_create",
      "settings_persona_set",
      "settings_skill_toggle",
      "settings_skills",
    ]);
    const before = settingsBytes();
    for (const name of [
      "settings_service_set",
      "settings_key_set",
      "settings_mcp_set",
      "settings_http_set",
      "settings_webhook_create",
    ])
      expect(
        await nova.tools.execute(name, webhook(), session()),
      ).toMatchObject({
        ok: false,
        error: "Unknown tool or integration unavailable",
      });
    expect(settingsBytes()).toBe(before);
    expect(
      await approve("settings_instruction_create", {
        ...instructionArgs,
        type: "webhook",
        http: webhook().http,
      }),
    ).toMatchObject({ ok: true });
    expect(
      nova.store
        .get()
        .skills.every((skill) => skill.type === "instruction" && !skill.http),
    ).toBe(true);
  });

  it("lists only safe skill metadata and refuses webhook toggles even after confirmation", async () => {
    const hook = normalizeSkill(webhook());
    nova.store.update((next) => {
      next.skills.push(hook as never);
    });
    const result = await nova.tools.execute("settings_skills", {}, session());
    expect(result).toMatchObject({
      ok: true,
      result: {
        skills: [
          {
            id: "filmavond",
            name: "Filmavond",
            type: "instruction",
            enabled: true,
            version: 1,
          },
          {
            id: hook.id,
            name: hook.name,
            type: "webhook",
            enabled: true,
            version: 1,
          },
        ],
      },
    });
    const shown = JSON.stringify([result, nova.tools.forModel()]);
    for (const secret of [
      "192.168.2.50",
      "X-Source",
      "X-Token",
      "geheim-123",
      "secretHeaders",
      "headers",
    ])
      expect(shown).not.toContain(secret);
    const before = settingsBytes();
    expect(
      await approve("settings_skill_toggle", { id: hook.id, enabled: false }),
    ).toMatchObject({ ok: false });
    expect(settingsBytes()).toBe(before);
    expect(nova.audits.some((row) => row.tool === "settings_change")).toBe(
      false,
    );
  });

  it.each([
    ["settings_persona_set", { text: "x".repeat(2001) }],
    ["settings_instruction_create", { name: "x", instructions: "Fine" }],
    [
      "settings_instruction_create",
      { name: "Valid", instructions: "x".repeat(4001) },
    ],
    ["settings_instruction_create", { name: "Valid", instructions: " " }],
    [
      "settings_instruction_create",
      {
        name: "Valid",
        instructions: "Fine",
        examples: Array(9).fill("example"),
      },
    ],
    ["settings_skill_toggle", { id: "missing", enabled: false }],
    ["settings_skill_toggle", { id: "filmavond", enabled: "invalid" }],
  ])("%s refuses invalid input without writing", async (name, args) => {
    const before = settingsBytes();
    const update = vi.spyOn(nova.store, "update");
    try {
      const id = session();
      let result = await nova.tools.execute(name as string, args, id);
      if (result.requiresConfirmation) {
        const approval = confirmations.take(id, result.action!.confirmationId)!;
        result = await nova.tools.execute(
          name as string,
          approval.args,
          id,
          approval,
        );
      }
      expect(result.ok).toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(settingsBytes()).toBe(before);
      expect(nova.audits.some((row) => row.tool === "settings_change")).toBe(
        false,
      );
    } finally {
      update.mockRestore();
    }
  });

  it("refuses skill 51 after confirmation without writing", async () => {
    nova.store.update((next) => {
      next.skills = Array.from(
        { length: 50 },
        (_, index) =>
          normalizeSkill(playbook({ name: `Skill ${index}` })) as never,
      );
    });
    const before = settingsBytes();
    const update = vi.spyOn(nova.store, "update");
    try {
      expect(
        await approve("settings_instruction_create", instructionArgs),
      ).toMatchObject({ ok: false });
      expect(update).not.toHaveBeenCalled();
      expect(settingsBytes()).toBe(before);
      expect(nova.store.get().skills).toHaveLength(50);
    } finally {
      update.mockRestore();
    }
  });
});
