import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFreePolicy,
  deleteNativeMemoryRecords,
  importSettings,
  removeNativeSkill,
  replaceNativePrompt,
  rollbackNativeMemory,
  rollbackNativeSkillMode,
  rollbackWorkspaceProjectSelection,
  setNativeMemory,
  setNativeSkillMode,
  updateNativeMemoryRecord,
} from "./settings.ts";

afterEach(() => vi.unstubAllGlobals());

async function call(run: () => Promise<unknown>) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await run();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  return { url, method: init.method, body: JSON.parse(String(init.body)) };
}

describe("settings changes take effect in one request", () => {
  it.each([
    [
      "native memory switch",
      () => setNativeMemory(true),
      "/api/settings/omniroute/native/memory",
      { enabled: true },
    ],
    [
      "native memory rollback",
      () => rollbackNativeMemory("rev"),
      "/api/settings/omniroute/native/memory/rollback",
      { revisionId: "rev" },
    ],
    [
      "memory record bulk delete",
      () => deleteNativeMemoryRecords(["a", "b"]),
      "/api/settings/omniroute/native/memories/delete-many",
      { ids: ["a", "b"] },
    ],
    [
      "memory record update",
      () => updateNativeMemoryRecord("a", "tekst"),
      "/api/settings/omniroute/native/memories/update",
      { id: "a", content: "tekst" },
    ],
    [
      "prompt",
      () =>
        replaceNativePrompt({
          enabled: true,
          prefixPrompt: "a",
          suffixPrompt: "",
        }),
      "/api/settings/omniroute/native/prompt",
      { enabled: true, prefixPrompt: "a", suffixPrompt: "" },
    ],
    [
      "skill mode",
      () => setNativeSkillMode("s 1", "off"),
      "/api/settings/omniroute/native/skills/s%201",
      { mode: "off" },
    ],
    [
      "skill mode rollback",
      () => rollbackNativeSkillMode("s", "rev"),
      "/api/settings/omniroute/native/skills/s/rollback",
      { revisionId: "rev" },
    ],
    [
      "skill removal",
      () => removeNativeSkill("s"),
      "/api/settings/omniroute/native/skills/s/remove",
      {},
    ],
    [
      "free policy",
      () => applyFreePolicy({ selection: [] }),
      "/api/settings/omniroute/policy",
      { selection: [] },
    ],
    [
      "project rollback",
      () => rollbackWorkspaceProjectSelection("rev"),
      "/api/settings/workspace/projects/history/rev/rollback",
      {},
    ],
    [
      "backup import",
      () => importSettings({ format: "nova-settings" }, "merge"),
      "/api/settings/import",
      { data: { format: "nova-settings" }, mode: "merge" },
    ],
  ])("%s", async (_name, run, url, body) => {
    const sent = await call(run);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(url);
    expect(sent.body).toEqual(body);
    expect(JSON.stringify(sent.body)).not.toMatch(
      /sessionId|confirmationId|approve|acknowledge/,
    );
  });
});
