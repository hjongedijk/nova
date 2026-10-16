import type { GlyphName } from "./types.ts";

/**
 * Line glyphs on a 24x24 grid, drawn with the current stroke colour. The words are always written
 * next to them: a glyph is a quick read, never the only carrier of the information.
 */
export interface GlyphDef {
  /** Stroked paths. */
  paths: string[];
  /** Filled shapes (dots). */
  fills?: string[];
}

const CLOUD_HIGH =
  "M7.5 14.5h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 7.4 8.7 3.1 3.1 0 0 0 7.5 14.5z";
const CLOUD_LOW =
  "M7.5 17h9a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 7.4 11.2 3.1 3.1 0 0 0 7.5 17z";
const SUN_RAYS =
  "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4";
const MOON = "M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.5 7.5 0 1 0 9.7 9.7z";

export const GLYPHS: Record<GlyphName, GlyphDef> = {
  clear: { paths: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", SUN_RAYS] },
  night: { paths: [MOON] },
  partly: {
    paths: [
      "M8.5 3.5v1.2M3.2 8.8h1.2M4.7 5l.9.9M12.3 5l-.9.9",
      "M8.5 6.8a2.7 2.7 0 0 0-2.4 4",
      CLOUD_LOW.replace("M7.5 17", "M9 19").replace("h9", "h8.5"),
    ],
  },
  "night-cloud": {
    paths: [
      "M12.8 4.6a4.7 4.7 0 0 0-6.2 6",
      "M6.2 5.2A4.7 4.7 0 0 0 8.4 11",
      CLOUD_LOW.replace("M7.5 17", "M9 19").replace("h9", "h8.5"),
    ],
  },
  cloud: { paths: [CLOUD_LOW] },
  fog: { paths: ["M6 9h12M4 13h16M7 17h10M9 21h6"] },
  drizzle: { paths: [CLOUD_HIGH, "M9 17.5v1.5M13 17.5v1.5M11 20.5v1.2"] },
  rain: { paths: [CLOUD_HIGH, "M8.5 17l-1 3M12.5 17l-1 3M16.5 17l-1 3"] },
  snow: {
    paths: [CLOUD_HIGH],
    fills: [
      "M8.5 18.5a1 1 0 1 0 0 .01",
      "M12.5 20.5a1 1 0 1 0 0 .01",
      "M16.5 18.5a1 1 0 1 0 0 .01",
    ],
  },
  storm: { paths: [CLOUD_HIGH, "M12.8 14.5l-2.6 3.6h2.4l-1.4 3.4"] },
  unknown: {
    paths: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      "M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5M12 16.6v.2",
    ],
  },
  timer: {
    paths: [
      "M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
      "M12 10v4.2l2.6 1.6M9.5 2.5h5",
    ],
  },
  "mark-ok": {
    paths: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M7.8 12.4l3 3 5.6-6.2"],
  },
  "mark-active": {
    paths: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
    fills: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  },
  "mark-warning": { paths: ["M12 3.5L21.5 20h-19z", "M12 10v5M12 17.6v.2"] },
  "mark-critical": {
    paths: [
      "M12 2.5l9.5 9.5-9.5 9.5L2.5 12z",
      "M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4",
    ],
  },
  "mark-off": { paths: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12h8"] },
  "mark-unknown": {
    paths: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      "M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5M12 16.6v.2",
    ],
  },
};
