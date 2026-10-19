import { afterEach, describe, expect, it, vi } from "vitest";
import { pushVoiceProfile, reconcileVoiceProfile } from "./voice-profile.ts";

afterEach(() => vi.unstubAllGlobals());

describe("voice profile mirror", () => {
  it("PUTs the profile without any unlock header", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await pushVoiceProfile({ voice: "nl-NL-FennaNeural", rate: -3, pitch: -2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/settings/voice-profile");
    expect(init.method).toBe("PUT");
    expect(JSON.stringify(init.headers ?? {})).not.toContain("x-nova");
    expect(JSON.parse(String(init.body))).toEqual({
      voice: "nl-NL-FennaNeural",
      rate: -3,
      pitch: -2,
    });
  });
  it("never throws when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    await expect(
      pushVoiceProfile({ rate: 0, pitch: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe("voice profile reconcile", () => {
  const local = { voice: "nl-NL-MaartenNeural", rate: -3, pitch: -2 };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("pushes the stored profile when the server differs", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? json(local)
        : json({ rate: -3, pitch: -2, initialized: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileVoiceProfile(local)).resolves.toMatchObject({
      status: "synced",
    });
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      ...local,
      initialize: true,
    });
  });
  it("does nothing when the server already matches", async () => {
    const fetchMock = vi.fn(async () => json(local));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileVoiceProfile(local)).resolves.toMatchObject({
      status: "unchanged",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps the shared profile when an older client has a different voice", async () => {
    const remote = { voice: "nl-NL-ColetteNeural", rate: 1, pitch: -1 };
    const request = vi.fn(async () => json(remote));
    vi.stubGlobal("fetch", request);
    await expect(reconcileVoiceProfile(local)).resolves.toEqual({
      status: "unchanged",
      profile: remote,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("preserves a configured default voice and custom prosody", async () => {
    const remote = { rate: 2, pitch: 1, initialized: true };
    const request = vi.fn(async () => json(remote));
    vi.stubGlobal("fetch", request);
    await expect(reconcileVoiceProfile(local)).resolves.toEqual({
      status: "unchanged",
      profile: remote,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reports a failure instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "nope" }, 403)),
    );
    const result = await reconcileVoiceProfile(local);
    expect(result.status).toBe("failed");
  });
});
