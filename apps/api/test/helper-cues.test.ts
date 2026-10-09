import { describe, expect, it, vi } from "vitest";
// Runtime import keeps browser DOM types outside the API compiler's rootDir.
const modulePath = new URL(
  "../../web/src/lib/voice/helper-cues.ts",
  import.meta.url,
).pathname;
interface CuePreferences {
  enabled: boolean;
  volume: number;
  theme: "soft" | "playful" | "minimal";
  cues?: Record<string, boolean>;
  quiet?: { enabled: boolean; start: string; end: string };
}
const { HELPER_CUES, HELPER_CUE_NAMES, createHelperCues, cueQuiet } =
  (await import(modulePath)) as {
    HELPER_CUES: Record<
      string,
      { frequency: number; offset: number; duration: number }[]
    >;
    HELPER_CUE_NAMES: string[];
    createHelperCues: (
      context: () => unknown,
      preferences: () => CuePreferences,
    ) => {
      play(cue: string): boolean;
      stop(): void;
      setActivity(speaking: boolean, listening: boolean): void;
    };
    cueQuiet(preferences: CuePreferences, date: Date): boolean;
  };

const defaults: CuePreferences = { enabled: true, volume: 0.5, theme: "soft" };
function audio() {
  const nodes: {
    oscillator: ReturnType<typeof oscillator>;
    gain: ReturnType<typeof gain>;
  }[] = [];
  const gain = () => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn().mockReturnValue({}),
    disconnect: vi.fn(),
  });
  const oscillator = () => ({
    frequency: { value: 0 },
    type: "",
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    onended: null as (() => void) | null,
  });
  const context = {
    currentTime: 10,
    state: "running",
    destination: {},
    createOscillator: () => {
      const osc = oscillator();
      const amp = gain();
      osc.connect.mockReturnValue(amp);
      nodes.push({ oscillator: osc, gain: amp });
      return osc;
    },
    createGain: () => nodes.at(-1)!.gain,
  };
  return { nodes, context };
}

describe("helper cues", () => {
  it("defines 15 original short phrases with bounded frequencies and duration", () => {
    expect(HELPER_CUE_NAMES).toHaveLength(15);
    for (const cue of HELPER_CUE_NAMES) {
      const notes = HELPER_CUES[cue]!;
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.length).toBeLessThanOrEqual(5);
      for (const note of notes) {
        expect(note.frequency).toBeGreaterThanOrEqual(100);
        expect(note.frequency).toBeLessThanOrEqual(1000);
        expect(note.offset + note.duration).toBeLessThan(2);
      }
    }
  });

  it("honours daytime, overnight, all-day, and invalid quiet schedules", () => {
    const prefs = (start: string, end: string) => ({
      ...defaults,
      quiet: { enabled: true, start, end },
    });
    const at = (hour: number) => new Date(2026, 9, 9, hour);
    expect(cueQuiet(prefs("08:00", "18:00"), at(8))).toBe(true);
    expect(cueQuiet(prefs("08:00", "18:00"), at(18))).toBe(false);
    expect(cueQuiet(prefs("22:00", "07:00"), at(23))).toBe(true);
    expect(cueQuiet(prefs("22:00", "07:00"), at(6))).toBe(true);
    expect(cueQuiet(prefs("22:00", "07:00"), at(12))).toBe(false);
    expect(cueQuiet(prefs("00:00", "00:00"), at(12))).toBe(true);
    expect(cueQuiet(prefs("bad", "07:00"), at(12))).toBe(true);
  });

  it("stops cues immediately for speech or listening and never queues them", () => {
    const { nodes, context } = audio();
    const player = createHelperCues(
      () => context,
      () => defaults,
    );
    expect(player.play("greet")).toBe(true);
    expect(nodes).toHaveLength(3);
    player.setActivity(true, false);
    for (const node of nodes) {
      expect(node.oscillator.stop).toHaveBeenCalledTimes(2);
      expect(node.oscillator.disconnect).toHaveBeenCalled();
      expect(node.gain.disconnect).toHaveBeenCalled();
    }
    expect(player.play("notice")).toBe(false);
    player.setActivity(false, true);
    expect(player.play("thinking")).toBe(false);
    player.setActivity(false, false);
    expect(player.play("wake")).toBe(true);
  });

  it("applies theme and cue preferences with independent, capped low gain", () => {
    const { nodes, context } = audio();
    let preferences: CuePreferences = {
      ...defaults,
      volume: 10,
      theme: "minimal",
    };
    const player = createHelperCues(
      () => context,
      () => preferences,
    );
    expect(player.play("done")).toBe(true);
    expect(nodes).toHaveLength(1);
    expect(
      nodes[0]!.gain.gain.exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(0.035, 10.02);
    preferences = { ...defaults, cues: { notice: false } };
    expect(player.play("notice")).toBe(false);
    preferences = { ...defaults, enabled: false };
    expect(player.play("done")).toBe(false);
    preferences = { ...defaults, volume: NaN };
    expect(player.play("done")).toBe(false);
  });

  it("fails silently when browser audio is unavailable", () => {
    const player = createHelperCues(
      () => {
        throw new Error("No audio");
      },
      () => defaults,
    );
    expect(player.play("touch")).toBe(false);
    expect(() => player.stop()).not.toThrow();
  });
});
