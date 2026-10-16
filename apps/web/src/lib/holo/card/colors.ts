import { statusColor } from "../colors.ts";
import type { Tone } from "./types.ts";

const DARK: Record<
  "accent" | "rain" | "warm" | "muted" | "text" | "dim",
  string
> = {
  accent: "#6ddcf5",
  rain: "#6aa8ff",
  warm: "#ffb86b",
  muted: "#7d8bb0",
  text: "#f1f4ff",
  dim: "#aab3d2",
};
const LIGHT: typeof DARK = {
  accent: "#0a7f9c",
  rain: "#2f6fd6",
  warm: "#b5620a",
  muted: "#7a7896",
  text: "#14182b",
  dim: "#4c5373",
};

/** CSS colour of a tone. Status tones share the colours of the rest of the viewer. */
export function toneColor(
  tone: Tone | "text" | "dim",
  theme: "dark" | "light" = "dark",
): string {
  const table = theme === "light" ? LIGHT : DARK;
  if (tone in table) return table[tone as keyof typeof table];
  return statusColor(tone as never, theme);
}
