import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverInputDevices,
  onInputDeviceChange,
  openSelectedInputStream,
  selectedInputDevice,
  setSelectedInputDevice,
} from "./input-device.ts";

let media: EventTarget & {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
};
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
  media = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(),
  });
  vi.stubGlobal("navigator", {
    userAgent: "Chrome/140.0",
    mediaDevices: media,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("persisted microphone selection", () => {
  it("reuses persisted exact device without a permission probe or enumeration", async () => {
    values.set("novaAudioInput", "saved-mic");
    const stream = {};
    media.getUserMedia.mockResolvedValue(stream);
    expect(selectedInputDevice()).toBe("saved-mic");
    expect(await openSelectedInputStream()).toBe(stream);
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: { deviceId: { exact: "saved-mic" } },
    });
    expect(media.enumerateDevices).not.toHaveBeenCalled();
  });

  it("keeps the chosen microphone when unplugged or permission is denied", async () => {
    setSelectedInputDevice("saved-mic");
    for (const name of ["NotFoundError", "NotAllowedError"]) {
      media.getUserMedia.mockRejectedValue(
        new DOMException("unavailable", name),
      );
      await expect(openSelectedInputStream()).rejects.toMatchObject({ name });
      expect(selectedInputDevice()).toBe("saved-mic");
    }
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("stops the permission probe before discovering inputs", async () => {
    const stop = vi.fn();
    media.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    media.enumerateDevices.mockImplementation(() => {
      expect(stop).toHaveBeenCalledOnce();
      return [{ kind: "audioinput", deviceId: "one" }, { kind: "audiooutput" }];
    });
    expect(await discoverInputDevices()).toEqual([
      { kind: "audioinput", deviceId: "one" },
    ]);
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
  });

  it("synchronizes local changes, other tabs and reconnects; removes all listeners", () => {
    const listener = vi.fn();
    const cleanup = onInputDeviceChange(listener);
    setSelectedInputDevice("one");
    const dispatchStorage = (key: string | null) => {
      const event = Object.assign(new Event("storage"), { key });
      window.dispatchEvent(event);
    };
    dispatchStorage("unrelated");
    expect(listener).toHaveBeenCalledTimes(1);
    dispatchStorage("novaAudioInput");
    dispatchStorage(null);
    media.dispatchEvent(new Event("devicechange"));
    expect(listener).toHaveBeenCalledTimes(4);
    cleanup();
    setSelectedInputDevice("two");
    dispatchStorage("novaAudioInput");
    media.dispatchEvent(new Event("devicechange"));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
