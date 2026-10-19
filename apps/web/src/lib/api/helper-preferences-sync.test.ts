import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperPreferences } from "@nova/contracts";
import {
  persistHelperPreferences,
  helperPreferenceWrites,
} from "./settings.ts";

afterEach(() => vi.unstubAllGlobals());
describe("helper preference saves", () => {
  it("snapshots and orders rapid edits before accepting remote updates", async () => {
    let finishFirst!: (response: Response) => void;
    const request = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(() => {
      if (request.mock.calls.length === 1)
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });
    vi.stubGlobal("fetch", request);
    const prefs = { shape: "orb" } as HelperPreferences;
    const first = persistHelperPreferences(prefs);
    prefs.shape = "ring";
    const second = persistHelperPreferences(prefs);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(helperPreferenceWrites.pending).toBe(2);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).shape).toBe(
      "orb",
    );
    finishFirst(new Response(JSON.stringify({ ok: true })));
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).shape).toBe(
      "ring",
    );
    expect(helperPreferenceWrites.pending).toBe(0);
  });
});
