import { describe, expect, it } from "vitest";
import {
  BargeInDetector,
  UtteranceEndpoint,
  backoffDelay,
  classifyRecognitionError,
  clampNumber,
  hiddenTooLong,
  idleExpired,
  isEndPhrase,
  micErrorMessage,
  needsPermissionForLabels,
  nextPhase,
  pickDevice,
  rmsLevel,
  shouldGiveUp,
} from "./conversation-logic.ts";

describe("end phrases", () => {
  it("accepts whole-utterance end phrases", () => {
    for (const text of [
      "stop",
      "Stop.",
      "tot straks",
      "Dat was het!",
      "bye",
      "Hey NOVA, stop",
      "ok tot straks",
    ])
      expect(isEndPhrase(text)).toBe(true);
  });
  it("ignores phrases inside real sentences", () => {
    for (const text of [
      "stop de muziek",
      "wat betekent bye",
      "",
      "dat was het weer van gisteren",
      "nova",
    ])
      expect(isEndPhrase(text)).toBe(false);
  });
});

describe("backoff", () => {
  it("doubles and gives up after three retries", () => {
    expect([1, 2, 3].map(backoffDelay)).toEqual([400, 800, 1600]);
    expect(shouldGiveUp(3)).toBe(false);
    expect(shouldGiveUp(4)).toBe(true);
  });
  it("classifies errors", () => {
    expect(classifyRecognitionError("no-speech")).toBe("quiet");
    expect(classifyRecognitionError("aborted")).toBe("quiet");
    expect(classifyRecognitionError("network")).toBe("retry");
    expect(classifyRecognitionError("not-allowed")).toBe("fatal");
  });
});

describe("timeouts", () => {
  it("idle and hidden", () => {
    expect(idleExpired(0, 59_999, 60_000)).toBe(false);
    expect(idleExpired(0, 60_000, 60_000)).toBe(true);
    expect(hiddenTooLong(null, 999_999)).toBe(false);
    expect(hiddenTooLong(0, 119_999)).toBe(false);
    expect(hiddenTooLong(0, 120_000)).toBe(true);
  });
  it("clamps configurable numbers", () => {
    expect(clampNumber("1200", 1000, 700, 2500)).toBe(1200);
    expect(clampNumber("5", 1000, 700, 2500)).toBe(700);
    expect(clampNumber("abc", 1000, 700, 2500)).toBe(1000);
    expect(clampNumber("", 1000, 700, 2500)).toBe(1000);
  });
});

describe("utterance endpoint", () => {
  it("is ready only after the text stood still for the silence time", () => {
    const end = new UtteranceEndpoint(1000);
    expect(end.ready(5000)).toBe(false);
    end.update("hallo", 0);
    expect(end.ready(999)).toBe(false);
    end.update("hallo daar", 800);
    expect(end.ready(1500)).toBe(false);
    end.update("hallo daar", 1600); // unchanged: does not extend
    expect(end.ready(1800)).toBe(true);
    expect(end.take()).toBe("hallo daar");
    expect(end.hasText()).toBe(false);
  });
});

describe("turn machine", () => {
  it("runs a full turn", () => {
    let phase = nextPhase("off", "start");
    expect(phase).toBe("listening");
    phase = nextPhase(phase, "utterance");
    expect(phase).toBe("thinking");
    phase = nextPhase(phase, "reply-start");
    expect(phase).toBe("speaking");
    expect(nextPhase(phase, "barge-in")).toBe("listening");
    expect(nextPhase(phase, "reply-done")).toBe("listening");
  });
  it("ends from anywhere and never revives", () => {
    expect(nextPhase("speaking", "end")).toBe("ending");
    expect(nextPhase("ending", "utterance")).toBe("ending");
    expect(nextPhase("off", "utterance")).toBe("off");
    expect(nextPhase("listening", "barge-in")).toBe("listening");
  });
});

describe("barge-in", () => {
  it("needs a sustained level", () => {
    const detector = new BargeInDetector(0.1, 3);
    expect(detector.push(0.2)).toBe(false);
    expect(detector.push(0.2)).toBe(false);
    expect(detector.push(0.01)).toBe(false); // click resets
    expect(detector.push(0.2)).toBe(false);
    expect(detector.push(0.2)).toBe(false);
    expect(detector.push(0.2)).toBe(true);
  });
  it("computes rms of byte samples", () => {
    expect(rmsLevel([128, 128, 128])).toBe(0);
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel([255, 1, 255, 1])).toBeGreaterThan(0.9);
  });
});

describe("devices", () => {
  const devices = [
    { deviceId: "a", label: "Headset" },
    { deviceId: "b", label: "" },
  ];
  it("keeps a saved device that still exists, else falls back", () => {
    expect(pickDevice(devices, "a")).toEqual({ deviceId: "a", missing: false });
    expect(pickDevice(devices, "gone")).toEqual({
      deviceId: "",
      missing: true,
    });
    expect(pickDevice(devices, "")).toEqual({ deviceId: "", missing: false });
  });
  it("detects empty labels", () => {
    expect(needsPermissionForLabels([{ deviceId: "a", label: "" }])).toBe(true);
    expect(needsPermissionForLabels(devices)).toBe(false);
    expect(needsPermissionForLabels([])).toBe(false);
  });
  it("gives Dutch messages", () => {
    expect(micErrorMessage("NotAllowedError")).toContain("geblokkeerd");
    expect(micErrorMessage("NotFoundError")).toContain("Geen microfoon");
    expect(micErrorMessage("NotReadableError")).toContain("niet bereikbaar");
    expect(micErrorMessage("x")).toContain("werkt niet");
  });
});
