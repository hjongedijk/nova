import { afterEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("#lib/api/client.ts", () => ({ getJson }));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function subject(saved?: string) {
  const values = new Map<string, string>();
  if (saved) values.set("nova.light-sync", saved);
  vi.stubGlobal("$state", <T>(value: T) => value);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return {
    values,
    sync: await import("./light-sync.svelte.ts"),
  };
}

describe("room-light orb opt-in", () => {
  it("does not request lamp data before opt-in or after disabling", async () => {
    const { sync, values } = await subject();
    await sync.refreshLightSync();
    expect(getJson).not.toHaveBeenCalled();

    getJson.mockResolvedValue({
      areas: [{ areaId: "office", areaName: "Office", hue: 42 }],
    });
    sync.setLightSync(true, "office");
    await sync.refreshLightSync();
    expect(sync.lightSync.hue).toBe(42);
    expect(values.get("nova.light-sync")).toBe(
      '{"enabled":true,"areaId":"office"}',
    );

    sync.setLightSync(false);
    await sync.refreshLightSync();
    expect(sync.lightSync.hue).toBeNull();
    expect(getJson).toHaveBeenCalledTimes(2);
  });

  it("discards a response when opt-in is revoked while the request is pending", async () => {
    const { sync } = await subject();
    let resolve!: (value: unknown) => void;
    getJson.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    sync.setLightSync(true, "office");
    sync.setLightSync(false);
    resolve({ areas: [{ areaId: "office", areaName: "Office", hue: 12 }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(sync.lightSync.hue).toBeNull();
    expect(sync.lightSync.areas).toEqual([]);
  });

  it("rejects invalid saved area IDs and invalid API hue values", async () => {
    const { sync } = await subject('{"enabled":true,"areaId":"../secret"}');
    sync.loadLightSync();
    expect(sync.lightSync.areaId).toBe("");
    getJson.mockResolvedValue({
      areas: [{ areaId: "office", areaName: "Office", hue: 999 }],
    });
    await sync.refreshLightSync();
    expect(sync.lightSync.areas).toEqual([]);
    expect(sync.lightSync.hue).toBeNull();
  });
});
