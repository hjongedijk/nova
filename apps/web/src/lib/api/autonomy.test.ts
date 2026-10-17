import { afterEach, describe, expect, it, vi } from "vitest";
import { setAutonomyLevel } from "./autonomy.ts";

afterEach(() => vi.unstubAllGlobals());

describe("autonomy level client", () => {
  it("sends the admin header, which the settings API requires on every write", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ level: "independent" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await setAutonomyLevel("independent");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/settings/autonomy-level");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["x-nova-admin"]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ level: "independent" });
  });
});
