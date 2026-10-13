import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScreen, fitScreen } from "./screen-capture.ts";

afterEach(() => vi.unstubAllGlobals());

describe("screen snapshot bounds", () => {
  it("bounds both landscape and portrait frames without stretching", () => {
    expect(fitScreen(3840, 2160)).toEqual({ width: 1600, height: 900 });
    expect(fitScreen(1080, 1920)).toEqual({ width: 900, height: 1600 });
    expect(fitScreen(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("rejects an unavailable video frame", () => {
    expect(() => fitScreen(0, 1080)).toThrow("No screen frame");
  });

  it("stops the browser share immediately after one frame", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
      getVideoTracks: () => [{ stop }],
    };
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    const drawImage = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal("document", {
      createElement: (tag: string) =>
        tag === "video"
          ? {
              videoWidth: 1920,
              videoHeight: 1080,
              play: vi.fn().mockResolvedValue(undefined),
            }
          : {
              getContext: () => ({ drawImage }),
              toDataURL: () => "data:image/jpeg;base64,/9j/",
            },
    });
    const result = await captureScreen();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(drawImage).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.attachment.mimeType).toBe("image/jpeg");
    expect(result.attachment.content).toBe("/9j/");
  });

  it("stops the browser share when a frame cannot be read", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
          getVideoTracks: () => [{ stop }],
        }),
      },
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        videoWidth: 0,
        videoHeight: 0,
        play: vi.fn().mockResolvedValue(undefined),
      }),
    });
    await expect(captureScreen()).rejects.toThrow("No screen frame");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
