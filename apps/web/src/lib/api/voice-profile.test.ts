import { afterEach, describe, expect, it, vi } from "vitest";
import { pushVoiceProfile } from "./voice-profile.ts";

afterEach(() => vi.unstubAllGlobals());

describe("voice profile mirror", () => {
  it("PUTs the profile with the admin header", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await pushVoiceProfile({ voice: "nl-NL-FennaNeural", rate: -3, pitch: -2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/settings/voice-profile");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["x-nova-admin"]).toBe("1");
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
