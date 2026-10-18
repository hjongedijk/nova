/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures left from the removed confirmation flow */
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
import { createApp, playbook, type TestApp } from "./helpers.js";

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
  ["settings_helper_preference_set", { setting: "contrast", enabled: true }],
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
  it("offers exactly five personal settings tools with actions and extensions disabled", () => {
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
});

describe("settings chat cannot change integrations or persist invalid personal changes", () => {
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
    ["settings_helper_preference_set", { setting: "contrast", enabled: "yes" }],
    ["settings_helper_preference_set", { setting: "secret", enabled: true }],
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
});
