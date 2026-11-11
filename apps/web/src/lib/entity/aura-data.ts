/**
 * Aura as a real 3D figure: where her files are, how she is framed, and the timing of her birth and her small
 * motions. Pure numbers and functions, shared by the renderer and the tests.
 *
 * The figure (static/aura/aura-figure.glb and .json) is built by scripts/aura-figure.mjs from the MakeHuman base
 * mesh and targets (CC0 1.0): an adult female bust with a blank, smooth ovoid head, and the light lines laid on it.
 */

export const AURA_ASSETS = {
  /** The mesh: glTF with EXT_meshopt_compression; position, normal, _HEAD and _BREATH weights. */
  mesh: "/aura/aura-figure.glb",
  /** Landmarks (metres) and the light lines on the surface. */
  figure: "/aura/aura-figure.json",
  /** A still of the 3D figure, for browsers without WebGL2. */
  still: "/aura/aura-still.webp",
} as const;

export type AuraTier = "low" | "mid" | "high";

export interface FigureLine {
  w: number;
  warm: 0 | 1;
  face: 0 | 1;
  /** Per point: x, y, z, nx, ny, nz, head weight. */
  p: number[];
}

export interface FigureJson {
  source: string;
  neck: [number, number, number];
  head: { c: [number, number, number]; r: [number, number, number] };
  face: [number, number, number];
  breasts: [number, number, number][];
  shoulders: [number, number, number][];
  elbows: [number, number, number][];
  waist: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  lines: FigureLine[];
  /** The body's signed distance field (int8 mm, base64), for the hair. */
  sdf: { cell: number; min: number[]; dims: number[]; data: string };
}

/** The part of the figure that should fill the frame (metres): the head's top to below the bust. */
export const VIEW = {
  top: 0.775,
  bottom: 0.19,
  halfWidth: 0.31,
  fov: 28,
} as const;

/**
 * Where the camera stands for a W x H screen. Wide screens frame head to bust; tall screens (phones) keep the
 * shoulders in the width and the figure in the upper part of the screen, where the chat leaves room.
 */
export function auraCamera(
  W: number,
  H: number,
): { distance: number; targetY: number; fov: number } {
  const aspect = Math.max(0.1, W / Math.max(1, H));
  const t = Math.tan(((VIEW.fov / 2) * Math.PI) / 180);
  const halfH = (VIEW.top - VIEW.bottom) / 2;
  const byHeight = halfH / t;
  const byWidth = VIEW.halfWidth / (t * aspect);
  // Phones: head and bust fill about 85% of the height, centred (the arms may run off the sides).
  if (aspect < 0.8) {
    const d = halfH / 0.85 / t;
    return {
      distance: d,
      targetY: (VIEW.top + VIEW.bottom) / 2,
      fov: VIEW.fov,
    };
  }
  const distance = Math.max(byHeight, byWidth);
  const span = t * distance;
  // Keep the head's top a little below the screen's top.
  const targetY = VIEW.top + 0.035 - span;
  return { distance, targetY, fov: VIEW.fov };
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The birth, in seconds: particles leave a glow on the chest and fly to the surface, settling from the waist up;
 * the face comes last and ignites, then one soft shockwave runs out from it.
 */
export const BIRTH = {
  /** The glow swells before the first particle leaves. */
  lead: 0.35,
  /** Flight time of one particle. */
  flight: 1.05,
  /** Bottom-to-top spread of the landings. */
  spread: 1.25,
  /** The face's landings, after everything else. */
  faceAt: 1.85,
  faceSpread: 0.3,
  /** A landed part of the surface lights up in this time. */
  settle: 0.45,
  /** The shockwave. */
  ringAt: 3.25,
  ringTime: 1.0,
  /** All done: from here the frame is the rest frame. */
  total: 4.3,
  /** Height range the landings sweep (metres). */
  low: 0.25,
  high: 0.8,
} as const;

/** When the surface point at height y (metres) lands; `face` 0..1 is how much of it is face; `jitter` 0..1. */
export function arrival(y: number, face: number, jitter = 0.5): number {
  const h = smoothstep(BIRTH.low, BIRTH.high, y);
  const body = BIRTH.lead + BIRTH.spread * h + jitter * 0.18;
  const faceT = BIRTH.faceAt + BIRTH.faceSpread * (1 - h) + jitter * 0.08;
  return body + (faceT - body) * face + BIRTH.flight;
}

/** The same in GLSL (keep in step with `arrival`). */
export const ARRIVAL_GLSL = /* glsl */ `
float arrival(float y, float face, float jitter) {
  float h = smoothstep(${f(BIRTH.low)}, ${f(BIRTH.high)}, y);
  float body = ${f(BIRTH.lead)} + ${f(BIRTH.spread)} * h + jitter * 0.18;
  float faceT = ${f(BIRTH.faceAt)} + ${f(BIRTH.faceSpread)} * (1.0 - h) + jitter * 0.08;
  return mix(body, faceT, face) + ${f(BIRTH.flight)};
}
`;

/** A GLSL float literal. */
export function f(n: number): string {
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** The hair in the wind: gusts every 6 to 12 s, and the sway between them. */
export const WIND = {
  gustEvery: [6, 12] as const,
  gustLength: 2.6,
  /** Sideways push at full gust and at rest (m/s²), and the slow sway's frequency (Hz). */
  gust: 1.6,
  breeze: 0.35,
  sway: 0.21,
} as const;

/** Gust strength 0..1 at time t: a soft swell every 6 to 12 s (deterministic). */
export function gustAt(t: number): number {
  let start = 0;
  for (let i = 0; i < 400; i++) {
    const gap =
      WIND.gustEvery[0] +
      (WIND.gustEvery[1] - WIND.gustEvery[0]) *
        (0.5 + 0.5 * Math.sin(i * 12.9898 + 4.1));
    if (t < start + gap) {
      const x = (t - start) / WIND.gustLength;
      return x >= 0 && x <= 1 ? Math.sin(Math.PI * x) ** 2 : 0;
    }
    start += gap;
  }
  return 0;
}

/** The wind's force on the hair at time t (m/s², x and z), zero without motion. */
export function windForce(t: number, motion: number): [number, number] {
  if (motion <= 0) return [0, 0];
  const g = gustAt(t);
  const sway =
    Math.sin(2 * Math.PI * WIND.sway * t) * 0.6 +
    Math.sin(2 * Math.PI * 0.13 * t + 1.3) * 0.4;
  return [
    motion * (WIND.breeze * sway + WIND.gust * g),
    motion * (0.15 * Math.sin(t * 0.7) - 0.3 * g),
  ];
}

/**
 * The head's own life on top of following the pointer: slow, small turns and tilts from layered sines, and now and
 * then a gentle look aside that returns. Radians; all zero without motion.
 */
export const IDLE = { yaw: 0.08, pitch: 0.04, roll: 0.03, aside: 0.1 } as const;

export function idlePose(
  t: number,
  motion: number,
): { yaw: number; pitch: number; roll: number } {
  if (motion <= 0) return { yaw: 0, pitch: 0, roll: 0 };
  const n = (a: number, b: number, c: number) =>
    Math.sin(t * a) * 0.55 +
    Math.sin(t * b + 1.7) * 0.3 +
    Math.sin(t * c + 4.2) * 0.15;
  // A look aside every 12 s or so, held for a couple of seconds, eased in and out.
  const period = 12;
  const cycle = Math.floor(t / period);
  const phase =
    t - cycle * period - 3 - 3 * (0.5 + 0.5 * Math.sin(cycle * 7.3));
  const look =
    phase > 0 && phase < 3.2 ? Math.sin((Math.PI * phase) / 3.2) ** 2 : 0;
  const dir = Math.sin(cycle * 3.7 + 1.1) > 0 ? 1 : -1;
  return {
    yaw:
      motion *
      (IDLE.yaw * n(0.21, 0.37, 0.71) * 0.75 + dir * IDLE.aside * look),
    pitch: motion * IDLE.pitch * n(0.17, 0.43, 0.89),
    roll: motion * IDLE.roll * n(0.13, 0.31, 0.67),
  };
}

/** Rotation matrix (column-major 3x3, as three's Matrix3.fromArray) for yaw (y), pitch (x), roll (z). */
export function headMatrix(yaw: number, pitch: number, roll: number): number[] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // R = Ry * Rx * Rz, row-major first.
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const m = (a: number[], b: number[]) => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
    return o;
  };
  const r = m(m(ry, rx), rz);
  // To column-major.
  return [r[0]!, r[3]!, r[6]!, r[1]!, r[4]!, r[7]!, r[2]!, r[5]!, r[8]!];
}
