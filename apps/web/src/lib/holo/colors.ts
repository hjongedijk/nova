import type { HoloTheme, VizStatus } from "./types.ts";

/** Same hues as the HUD (app.css tokens), so a status reads the same everywhere. */
const DARK: Record<VizStatus, string> = {
  ok: "#8fe8c4",
  active: "#6ddcf5",
  warning: "#ffcf6b",
  critical: "#ff5b3a",
  off: "#6b6990",
  unknown: "#a9a6c4",
};
const LIGHT: Record<VizStatus, string> = {
  ok: "#0f8a5f",
  active: "#0a7f9c",
  warning: "#a86b00",
  critical: "#c4310f",
  off: "#7a7896",
  unknown: "#5c5a78",
};

export const STATUS_LABELS: Record<VizStatus, string> = {
  ok: "In orde",
  active: "Actief",
  warning: "Let op",
  critical: "Probleem",
  off: "Uit",
  unknown: "Onbekend",
};

export const resolveTheme = (
  theme: HoloTheme,
  prefersLight: boolean,
): "dark" | "light" =>
  theme === "auto" ? (prefersLight ? "light" : "dark") : theme;

export const statusColor = (
  status: VizStatus | undefined,
  theme: "dark" | "light",
): string => (theme === "light" ? LIGHT : DARK)[status ?? "unknown"];

const HEAT = ["#2b6cff", "#6ddcf5", "#ffcf6b", "#ff5b3a"];

const hex = (value: string): [number, number, number] => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

/** Colour for a 0..1 value; null (no data) is a neutral grey, never a heat colour. */
export function heatColor(
  value: number | null | undefined,
  theme: "dark" | "light" = "dark",
): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return theme === "light" ? "#9a98b4" : "#55536f";
  const t = Math.min(1, Math.max(0, value)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(t));
  const f = t - i;
  const a = hex(HEAT[i]!);
  const b = hex(HEAT[i + 1]!);
  const channel = (k: 0 | 1 | 2) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `#${[0, 1, 2]
    .map((k) =>
      channel(k as 0 | 1 | 2)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Shape per kind, so status never relies on colour alone. */
export type NodeShape =
  "sphere" | "box" | "cylinder" | "octahedron" | "icosahedron";
export function shapeOf(kind: string | undefined): NodeShape {
  switch (kind) {
    case "cluster":
    case "home":
    case "orchestrator":
    case "host":
      return "icosahedron";
    case "node":
    case "room":
    case "session":
    case "background":
    case "inventory":
      return "octahedron";
    case "lxc":
    case "service":
      return "box";
    case "storage":
      return "cylinder";
    default:
      return "sphere";
  }
}
