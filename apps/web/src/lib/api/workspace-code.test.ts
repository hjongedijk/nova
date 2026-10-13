import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceCodeRun } from "./settings.ts";

afterEach(() => vi.unstubAllGlobals());
describe("workspace run API", () => {
  it.each(["", "null", "{}"])(
    "treats empty run response %s as no run",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
      );
      expect(await getWorkspaceCodeRun()).toBeNull();
    },
  );
  it("rejects a malformed run before rendering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ output: "partial" })),
    );
    await expect(getWorkspaceCodeRun()).rejects.toThrow("Testuitvoer");
  });
  it("preserves an actual run", async () => {
    const run = {
      projectId: "demo",
      command: ["npm", "test"],
      output: "passed",
      durationMs: 10,
      exitCode: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(run)),
    );
    expect(await getWorkspaceCodeRun()).toEqual(run);
  });
});
