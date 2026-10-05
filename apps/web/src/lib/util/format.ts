/** Number and date formatting for the panels, Dutch like the prototype. */

export const gb = (bytes: number | null | undefined): string =>
  bytes == null
    ? "–"
    : (bytes / 1073741824).toFixed(bytes >= 107374182400 ? 0 : 1);

export const pct = (used: number, total: number): number =>
  total > 0 ? Math.min(100, (used / total) * 100) : 0;

export const clock = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleTimeString("nl-NL", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "–";

export const rate = (n: number): string =>
  n < 1024
    ? `${Math.round(n)} B/s`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} kB/s`
      : `${(n / 1048576).toFixed(1)} MB/s`;

export const cap = (text: string): string =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

export const nl = (value: number, digits = 1): string =>
  Number(value).toLocaleString("nl-NL", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const shortDate = (iso: string): string =>
  new Date(`${iso}T12:00:00`)
    .toLocaleDateString("nl-NL", { day: "numeric", month: "short" })
    .replace(".", "");

export const signed = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${nl(Math.abs(value))}%`;

export function isoWeek(date: Date): number {
  const t = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - first.getTime()) / 86400000 + 1) / 7);
}

/** Time left on a timer: m:ss, or h:mm:ss from an hour on. */
export function mmss(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** How long ago: "nu", "5 min", "3 u", "2 d". */
export function ago(iso: string | undefined): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso ?? "")) / 1000);
  if (!(seconds >= 0)) return "";
  if (seconds < 60) return "nu";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} u`;
  return `${Math.floor(seconds / 86400)} d`;
}

/** Dutch names of Home Assistant weather conditions. */
export const WEATHER: Record<string, string> = {
  sunny: "Zonnig",
  "clear-night": "Helder",
  cloudy: "Bewolkt",
  partlycloudy: "Half bewolkt",
  rainy: "Regen",
  pouring: "Zware regen",
  fog: "Mist",
  windy: "Winderig",
  "windy-variant": "Winderig",
  snowy: "Sneeuw",
  "snowy-rainy": "Natte sneeuw",
  lightning: "Onweer",
  "lightning-rainy": "Onweer met regen",
  hail: "Hagel",
  exceptional: "Uitzonderlijk",
};

export const PERSON_STATE: Record<string, string> = {
  home: "thuis",
  not_home: "weg",
  unknown: "onbekend",
};

/** The lit part of the moon: the bright limb plus the terminator as an ellipse. */
export function moonPath(fraction: number): string {
  const r = 24;
  const k = Math.cos(2 * Math.PI * fraction);
  const rx = Math.abs(k) * r;
  const waxing = fraction < 0.5;
  const limb = `M32 ${32 - r} A${r} ${r} 0 0 ${waxing ? 1 : 0} 32 ${32 + r}`;
  const sweep = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  return `${limb} A${rx} ${r} 0 0 ${sweep} 32 ${32 - r} Z`;
}

/** Where the sun is on its arc (SVG 200x50), or null when unknown. */
export function sunPosition(
  sun: { azimuth: number | null; aboveHorizon: boolean } | null | undefined,
): { cx: number; cy: number; opacity: number } | null {
  if (sun?.azimuth == null) return null;
  const theta = Math.min(1, Math.max(0, (sun.azimuth - 90) / 180)) * Math.PI;
  return {
    cx: 100 - 90 * Math.cos(theta),
    cy: sun.aboveHorizon ? 44 - 40 * Math.sin(theta) : 48,
    opacity: sun.aboveHorizon ? 1 : 0.35,
  };
}

/** Names of tool families in the activity feed. */
export const TOOL_AREAS: [RegExp, string][] = [
  [/^proxmox_/, "Proxmox"],
  [/^ha_/, "Home Assistant"],
  [/^(media|sonos|music)_/, "Muziek"],
  [/^memory_/, "Geheugen"],
  [/^windows_/, "Windows"],
  [/^termix_/, "Termix"],
  [/^pangolin_/, "Pangolin"],
  [/^mcp_/, "Extensie"],
  [/^omniroute_/, "OmniRoute"],
];

/** "Proxmox vm status" for proxmox_vm_status; unknown tools just lose their underscores. */
export function toolLabel(tool: string): string {
  const area = TOOL_AREAS.find(([re]) => re.test(tool));
  return area
    ? `${area[1]} ${tool.replace(area[0], "").replaceAll("_", " ")}`.trim()
    : tool.replaceAll("_", " ");
}
