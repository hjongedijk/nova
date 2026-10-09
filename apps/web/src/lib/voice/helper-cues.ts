/** Original, bounded oscillator phrases. No recordings or external sound assets. */
export const HELPER_CUE_NAMES = [
  "listening-start",
  "listening-end",
  "thinking",
  "done",
  "notice",
  "error",
  "approved",
  "declined",
  "greet",
  "goodnight",
  "file",
  "touch",
  "dizzy",
  "heart",
  "wake",
] as const;
export type HelperCue = (typeof HELPER_CUE_NAMES)[number];
export type CueTheme = "soft" | "playful" | "minimal";
export interface CuePreferences {
  enabled: boolean;
  volume: number;
  theme: CueTheme;
  cues?: Partial<Record<HelperCue, boolean>>;
  /** Local wall-clock hours, HH:MM. Equal endpoints mean quiet all day. */
  quiet?: { enabled: boolean; start: string; end: string };
}
export interface CueNote {
  frequency: number;
  offset: number;
  duration: number;
}
const phrase = (
  frequencies: number[],
  duration = 0.16,
  spacing = 0.12,
): readonly CueNote[] =>
  Object.freeze(
    frequencies.map((frequency, i) =>
      Object.freeze({ frequency, offset: i * spacing, duration }),
    ),
  );

export const HELPER_CUES: Readonly<Record<HelperCue, readonly CueNote[]>> =
  Object.freeze({
    "listening-start": phrase([520, 780]),
    "listening-end": phrase([620, 460]),
    thinking: phrase([220, 247, 220], 0.32, 0.38),
    done: phrase([480, 600, 720]),
    notice: phrase([600, 600], 0.18, 0.28),
    error: phrase([250, 190], 0.2, 0.18),
    approved: phrase([440, 660]),
    declined: phrase([380, 280]),
    greet: phrase([392, 494, 588], 0.2, 0.15),
    goodnight: phrase([440, 330, 220], 0.3, 0.22),
    file: phrase([320, 480, 640], 0.14, 0.09),
    touch: phrase([720], 0.08),
    dizzy: phrase([620, 540, 460, 380, 300], 0.13, 0.09),
    heart: phrase([440, 550, 660, 550], 0.18, 0.14),
    wake: phrase([280, 420, 560], 0.18, 0.16),
  });

function minute(value: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function cueQuiet(
  preferences: CuePreferences,
  now = new Date(),
): boolean {
  const quiet = preferences.quiet;
  if (!quiet?.enabled) return false;
  const start = minute(quiet.start);
  const end = minute(quiet.end);
  if (start === null || end === null) return true; // Invalid enabled schedule fails silent.
  const current = now.getHours() * 60 + now.getMinutes();
  return (
    start === end ||
    (start < end
      ? current >= start && current < end
      : current >= start || current < end)
  );
}

export interface HelperCuePlayer {
  play(cue: HelperCue, now?: Date): boolean;
  stop(): void;
  /** Call when speech/listening starts; cues remain suppressed until activity clears. */
  setActivity(speaking: boolean, listening: boolean): void;
}

/** Inject the existing shared audioContext. Never creates another context or loops a sound. */
export function createHelperCues(
  context: () => AudioContext,
  preferences: () => CuePreferences,
): HelperCuePlayer {
  const active = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();
  let occupied = false;
  const stop = () => {
    for (const node of active) {
      try {
        node.oscillator.stop();
      } catch {
        /* Already ended. */
      }
      node.oscillator.disconnect();
      node.gain.disconnect();
    }
    active.clear();
  };
  return {
    stop,
    setActivity(speaking, listening) {
      occupied = speaking || listening;
      if (occupied) stop();
    },
    play(cue, now = new Date()) {
      stop();
      const settings = preferences();
      const volume = Number.isFinite(settings.volume)
        ? Math.max(0, Math.min(1, settings.volume))
        : 0;
      if (
        occupied ||
        !settings.enabled ||
        !volume ||
        settings.cues?.[cue] === false ||
        cueQuiet(settings, now)
      )
        return false;
      try {
        const ctx = context();
        // Audio unlock belongs to the existing user-gesture handler. Do not queue hidden cues.
        if (ctx.state !== "running") return false;
        const all = HELPER_CUES[cue];
        const notes = settings.theme === "minimal" ? all.slice(0, 1) : all;
        const pitch = settings.theme === "playful" ? 1.18 : 1;
        const peak = volume * (cue === "thinking" ? 0.008 : 0.035);
        for (const note of notes) {
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          const node = { oscillator, gain };
          active.add(node);
          const at = ctx.currentTime + note.offset;
          oscillator.type = "sine";
          oscillator.frequency.value = note.frequency * pitch;
          gain.gain.setValueAtTime(0.00001, at);
          gain.gain.exponentialRampToValueAtTime(
            Math.max(0.00001, peak),
            at + 0.02,
          );
          gain.gain.exponentialRampToValueAtTime(0.00001, at + note.duration);
          oscillator.connect(gain).connect(ctx.destination);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
            active.delete(node);
          };
          oscillator.start(at);
          oscillator.stop(at + note.duration + 0.02);
        }
        return true;
      } catch {
        stop();
        return false;
      }
    },
  };
}
