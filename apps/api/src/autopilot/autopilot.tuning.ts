import { parseClock } from "../objectives/objectives.time.js";
import type {
  AutopilotSettings,
  Reaction,
  TuningCeiling,
  TuningState,
} from "./autopilot.types.js";

/*
 * Self-tuning from what the owner does with the autopilot's nudges. Only ever quieter than what the
 * owner chose (budget down, interval up, quiet hours wider, cooldowns longer) and back up to the
 * owner's values once nudges are acted on again. Each adjustment consumes the evidence behind it, so
 * the same dismissals never tighten the screws twice.
 */

const HOUR = 3_600_000;
const WINDOW_MS = 48 * HOUR;
const SCAN_WINDOW_MS = 7 * 24 * HOUR;
const MIN_BUDGET = 2;
const MAX_INTERVAL = 30;
const MAX_FACTOR = 8;
const QUIET_STEP = 30;
const QUIET_MAX_SHIFT = 120;

const negative = (r: Reaction) => r !== "acted";

export interface TuningChange {
  /** Partial settings to apply with applySettings. */
  patch: Record<string, unknown>;
  /** One short Dutch line per change, for the activity log. */
  note: string;
}

export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const ceilingOf = (s: AutopilotSettings): TuningCeiling => ({
  dailyBudget: s.dailyBudget,
  intervalMinutes: s.intervalMinutes,
  quietStart: s.quiet.start,
  quietEnd: s.quiet.end,
});

/** Distance in minutes going forward from a to b on the 24h clock. */
const forward = (a: number, b: number) => (((b - a) % 1440) + 1440) % 1440;

/**
 * Looks at the stored reactions and returns the adjustments to make now. Mutates `state`: consumed
 * reactions are removed, cooldown factors and the ceiling are updated.
 */
export function tune(
  state: TuningState,
  settings: AutopilotSettings,
  now: number,
): TuningChange[] {
  state.reactions = state.reactions.filter((r) => now - r.at < SCAN_WINDOW_MS);
  const changes: TuningChange[] = [];
  const ceiling = () => (state.ceiling ??= ceilingOf(settings));
  const consume = (drop: (r: TuningState["reactions"][number]) => boolean) => {
    state.reactions = state.reactions.filter((r) => !drop(r));
  };
  const recent = () => state.reactions.filter((r) => now - r.at < WINDOW_MS);

  // 1. Per scan: nudges of one kind that keep being brushed off come back less often.
  for (const scan of new Set(state.reactions.map((r) => r.scan))) {
    const own = state.reactions.filter((r) => r.scan === scan);
    if (own.length < 4) continue;
    const bad = own.filter((r) => negative(r.reaction)).length / own.length;
    const factor = state.cooldownFactor[scan] ?? 1;
    if (bad >= 0.75 && factor < MAX_FACTOR) {
      state.cooldownFactor[scan] = Math.min(MAX_FACTOR, factor * 2);
      consume((r) => r.scan === scan);
      changes.push({
        patch: {},
        note: `meldingen van '${scan}' komen ${state.cooldownFactor[scan]}x minder vaak (steeds genegeerd of weggeklikt)`,
      });
    } else if (bad <= 0.5 && factor > 1) {
      state.cooldownFactor[scan] = Math.max(1, factor / 2);
      consume((r) => r.scan === scan);
      changes.push({
        patch: {},
        note: `meldingen van '${scan}' komen weer vaker (je doet er iets mee)`,
      });
    }
  }

  // 2. Quiet hours (before volume, so its evidence is not used up): rebuffs that cluster just before the night starts or just after it ends.
  if (settings.quiet.enabled) {
    const start = parseClock(settings.quiet.start);
    const end = parseClock(settings.quiet.end);
    if (start !== null && end !== null) {
      const before = recent().filter(
        (r) => negative(r.reaction) && forward(r.minute, start) <= 120,
      );
      const after = recent().filter(
        (r) => negative(r.reaction) && forward(end, r.minute) < 120,
      );
      const c = ceiling();
      const cs = parseClock(c.quietStart) ?? start;
      const ce = parseClock(c.quietEnd) ?? end;
      if (before.length >= 3 && before.length >= after.length) {
        const shifted = forward(start, cs) + QUIET_STEP;
        if (shifted <= QUIET_MAX_SHIFT) {
          const next = formatClock(start - QUIET_STEP);
          changes.push({
            patch: { quiet: { start: next } },
            note: `stille uren starten eerder (${settings.quiet.start} naar ${next}): late meldingen worden weggeklikt`,
          });
          const stale = new Set(before);
          consume((r) => stale.has(r));
        }
      } else if (after.length >= 3) {
        const shifted = forward(ce, end) + QUIET_STEP;
        if (shifted <= QUIET_MAX_SHIFT) {
          const next = formatClock(end + QUIET_STEP);
          changes.push({
            patch: { quiet: { end: next } },
            note: `stille uren eindigen later (${settings.quiet.end} naar ${next}): vroege meldingen worden weggeklikt`,
          });
          const stale = new Set(after);
          consume((r) => stale.has(r));
        }
      }
    }
  }
  // 3. Overall volume: daily budget and scan interval.
  const bad = recent().filter((r) => negative(r.reaction));
  const good = recent().filter((r) => r.reaction === "acted");
  if (bad.length >= 4 && settings.dailyBudget > MIN_BUDGET) {
    ceiling();
    const next = settings.dailyBudget - 1;
    changes.push({
      patch: { dailyBudget: next },
      note: `dagbudget ${settings.dailyBudget} naar ${next}: veel meldingen genegeerd of weggeklikt`,
    });
    const stale = new Set(bad);
    consume((r) => stale.has(r));
  } else if (good.length >= 3 && state.ceiling) {
    const c = state.ceiling;
    const patch: Record<string, unknown> = {};
    const notes: string[] = [];
    if (settings.dailyBudget < c.dailyBudget) {
      patch.dailyBudget = settings.dailyBudget + 1;
      notes.push(
        `dagbudget ${settings.dailyBudget} naar ${settings.dailyBudget + 1}`,
      );
    }
    if (settings.intervalMinutes > c.intervalMinutes) {
      const interval = Math.max(
        c.intervalMinutes,
        Math.floor(settings.intervalMinutes / 1.5),
      );
      patch.intervalMinutes = interval;
      notes.push(
        `controle-interval ${settings.intervalMinutes} naar ${interval} minuten`,
      );
    }
    if (notes.length) {
      changes.push({
        patch,
        note: `${notes.join(", ")}: je reageert weer op meldingen`,
      });
      const stale = new Set(good);
      consume((r) => stale.has(r));
    }
  }
  const ignored = recent().filter((r) => r.reaction === "ignored");
  if (ignored.length >= 6 && settings.intervalMinutes < MAX_INTERVAL) {
    ceiling();
    const next = Math.min(
      MAX_INTERVAL,
      Math.ceil(settings.intervalMinutes * 1.5),
    );
    changes.push({
      patch: { intervalMinutes: next },
      note: `controle-interval ${settings.intervalMinutes} naar ${next} minuten: meldingen blijven onbeantwoord`,
    });
    const stale = new Set(ignored);
    consume((r) => stale.has(r));
  }

  return changes;
}
