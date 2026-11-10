/**
 * AURA's body, as numbers. One signed distance field describes a woman's upper body in adult proportions
 * (figure-drawing canon, about 7.5 heads tall): a rounded head with a softly sculpted mask face, a neck about half
 * the head's height, a gentle shoulder slope with collarbones, rounded arms, a natural bust and a rib cage that
 * tapers to the waist and opens to the hips.
 *
 * The primitives are declared once (PIECES) and both evaluated here in JS (hair guides, tests) and written out as
 * GLSL for the ray-marched surface (aura-shaders.ts), so the two never drift apart.
 *
 * Units: one head height. The chin sits at y = 0, the crown at y = CROWN; +z faces the viewer; the figure is
 * mirror symmetric in x (pieces marked `m` are mirrored through |x|).
 */

export type V3 = readonly [number, number, number];

type Shape =
  | { k: "ell"; c: V3; r: V3 }
  | { k: "sph"; c: V3; r: number }
  | { k: "cone"; a: V3; b: V3; r0: number; r1: number };

/** How a piece joins what came before it in its group: smooth union, or a soft carve (`cut`). */
interface Piece {
  s: Shape;
  /** Blend radius with the group so far (0 for the first piece). */
  k: number;
  cut?: boolean;
  /** Mirrored through |x|. Every piece off the centre line is. */
  m?: boolean;
  /** Breathing: chest pieces fill a little, shoulder pieces rise a little. */
  breath?: "fill" | "lift";
}

const ell = (c: V3, r: V3): Shape => ({ k: "ell", c, r });
const sph = (c: V3, r: number): Shape => ({ k: "sph", c, r });
const cone = (a: V3, b: V3, r0: number, r1 = r0): Shape => ({
  k: "cone",
  a,
  b,
  r0,
  r1,
});

/** The figure, group by group. The head group is evaluated in the head's own (turned) frame. */
export const PIECES = {
  head: [
    // A rounded cranium with forehead and temples; the face hangs in front of it and narrows to the jaw.
    { s: ell([0, 0.6, -0.05], [0.355, 0.41, 0.43]), k: 0 },
    { s: ell([0, 0.41, 0.07], [0.28, 0.41, 0.33]), k: 0.2 },
    { s: ell([0, 0.2, 0.05], [0.215, 0.2, 0.27]), k: 0.14 },
    { s: ell([0, 0.06, 0.15], [0.085, 0.08, 0.115]), k: 0.08 },
    { s: ell([0.17, 0.37, 0.24], [0.1, 0.075, 0.09]), k: 0.08, m: true },
    { s: ell([0, 0.56, 0.3], [0.23, 0.055, 0.09]), k: 0.08 },
    // Closed, serene eyes: a wide, shallow hollow under the brow, filled again by a softly rounded lid.
    { s: sph([0.118, 0.462, 0.46], 0.08), k: 0.14, cut: true, m: true },
    { s: ell([0.118, 0.452, 0.362], [0.064, 0.027, 0.03]), k: 0.035, m: true },
    // An elegant nose: slim bridge, rounded tip.
    { s: cone([0, 0.49, 0.35], [0, 0.34, 0.41], 0.016, 0.028), k: 0.07 },
    { s: sph([0, 0.335, 0.4], 0.03), k: 0.03 },
    // Gentle lips: two halves of the upper lip make the Cupid's bow; a fuller lower lip; a soft chin below.
    { s: ell([0.028, 0.206, 0.334], [0.05, 0.021, 0.034]), k: 0.025, m: true },
    { s: ell([0, 0.16, 0.33], [0.068, 0.026, 0.036]), k: 0.03 },
  ],
  neck: [
    { s: cone([0, 0.25, -0.06], [0, -0.5, -0.03], 0.165, 0.185), k: 0 },
    // Trapezius: a gentle slope from the side of the neck to the shoulder point.
    {
      s: cone([0.12, -0.27, -0.12], [0.66, -0.53, -0.08], 0.1),
      k: 0.2,
      m: true,
      breath: "lift",
    },
  ],
  torso: [
    { s: ell([0, -0.86, -0.04], [0.62, 0.55, 0.3]), k: 0, breath: "fill" },
    { s: ell([0, -1.45, -0.04], [0.49, 0.68, 0.27]), k: 0.3 },
    { s: ell([0, -2.0, -0.02], [0.34, 0.36, 0.22]), k: 0.25 },
    { s: ell([0, -2.9, -0.02], [0.6, 0.78, 0.29]), k: 0.32 },
    {
      s: ell([0.26, -1.0, 0.15], [0.2, 0.19, 0.175]),
      k: 0.15,
      m: true,
      breath: "fill",
    },
    // Collarbones: a slim ridge from the notch to the shoulder.
    {
      s: cone([0.045, -0.47, 0.13], [0.6, -0.44, 0.03], 0.019),
      k: 0.07,
      m: true,
      breath: "lift",
    },
  ],
  arm: [
    {
      s: ell([0.71, -0.7, -0.05], [0.16, 0.22, 0.17]),
      k: 0,
      m: true,
      breath: "lift",
    },
    {
      s: cone([0.74, -0.74, -0.05], [0.9, -2.0, -0.08], 0.135, 0.098),
      k: 0.12,
      m: true,
      breath: "lift",
    },
    {
      s: cone([0.9, -2.0, -0.08], [1.0, -3.2, 0.03], 0.095, 0.076),
      k: 0.05,
      m: true,
    },
  ],
} satisfies Record<string, Piece[]>;

/** How the groups join: neck and shoulders onto the torso, arms onto that, the head last. */
const JOIN = { neck: 0.16, arm: 0.13, head: 0.1 } as const;

/** The head turns about the top of the neck. */
export const PIVOT: V3 = [0, 0.05, -0.05];
/** Where the weave starts (the heart, between the breasts) and where the state bloom spreads from (the face). */
export const HEART: V3 = [0, -0.74, 0.25];
export const FACE: V3 = [0, 0.42, 0.38];
export const CROWN = 1.01;
export const CHIN = 0.0;
/** The weave is complete once its front has passed every point of the body by this distance. */
export const WEAVE_REACH = 3.0;
/** At rest the head is turned and tilted a touch: calm, not a mugshot. */
export const REST_POSE = { yaw: 0.07, pitch: 0.03, roll: 0.045 } as const;

/* ---------------- evaluation in JS ---------------- */

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function shape(s: Shape, x: number, y: number, z: number): number {
  if (s.k === "sph")
    return Math.hypot(x - s.c[0], y - s.c[1], z - s.c[2]) - s.r;
  if (s.k === "ell") {
    const px = (x - s.c[0]) / s.r[0];
    const py = (y - s.c[1]) / s.r[1];
    const pz = (z - s.c[2]) / s.r[2];
    const k0 = Math.hypot(px, py, pz);
    const k1 = Math.hypot(px / s.r[0], py / s.r[1], pz / s.r[2]);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(...s.r);
  }
  const pax = x - s.a[0];
  const pay = y - s.a[1];
  const paz = z - s.a[2];
  const bax = s.b[0] - s.a[0];
  const bay = s.b[1] - s.a[1];
  const baz = s.b[2] - s.a[2];
  const h = Math.max(
    0,
    Math.min(
      1,
      (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
    ),
  );
  return (
    Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) -
    (s.r0 + (s.r1 - s.r0) * h)
  );
}

function group(
  pieces: readonly Piece[],
  x: number,
  y: number,
  z: number,
  soft = 0,
): number {
  let d = Infinity;
  // The mirror fold is rounded on the face (`soft`): a hard |x| leaves a crease down the nose wherever a
  // mirrored piece (the eyes) still reaches the centre line.
  const mx = soft > 0 ? Math.sqrt(x * x + soft) : Math.abs(x);
  for (const p of pieces) {
    const e = shape(p.s, p.m ? mx : x, y, z);
    d = d === Infinity ? e : p.cut ? -smin(-d, e, p.k) : smin(d, e, p.k);
  }
  return d;
}

const HEAD_FOLD = 0.0016;

/** The head alone, rest pose. */
export function headField(x: number, y: number, z: number): number {
  return group(PIECES.head, x, y, z, HEAD_FOLD);
}

/** The whole figure, rest pose: negative inside. */
export function auraField(x: number, y: number, z: number): number {
  let body = smin(
    group(PIECES.torso, x, y, z),
    group(PIECES.neck, x, y, z),
    JOIN.neck,
  );
  body = smin(body, group(PIECES.arm, x, y, z), JOIN.arm);
  return smin(body, headField(x, y, z), JOIN.head);
}

function gradient(
  f: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const e = 0.002;
  const gx = f(x + e, y, z) - f(x - e, y, z);
  const gy = f(x, y + e, z) - f(x, y - e, z);
  const gz = f(x, y, z + e) - f(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}

/* ---------------- the same field in GLSL ---------------- */

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const v = (a: readonly number[]) => `vec3(${a.map(f).join(", ")})`;

function glslShape(s: Shape, p: string, fill: string): string {
  if (s.k === "sph") return `(length(${p} - ${v(s.c)}) - ${f(s.r)})`;
  if (s.k === "ell") return `ellA(${p}, ${v(s.c)}, ${v(s.r)}${fill})`;
  return `coneA(${p}, ${v(s.a)}, ${v(s.b)}, ${f(s.r0)}, ${f(s.r1)})`;
}

function glslGroup(
  name: string,
  pieces: readonly Piece[],
  space: "p" | "ph",
): string {
  const lines = [`float ${name} = 0.0;`];
  pieces.forEach((pc, i) => {
    const mirrored = space === "p" ? "q" : "qh";
    const base = pc.m ? mirrored : space;
    const p = pc.breath === "lift" ? `(${base} - lift)` : base;
    const e = glslShape(pc.s, p, pc.breath === "fill" ? " * fill" : "");
    if (i === 0) lines.push(`${name} = ${e};`);
    else if (pc.cut)
      lines.push(`${name} = -sminA(-${name}, ${e}, ${f(pc.k)});`);
    else lines.push(`${name} = sminA(${name}, ${e}, ${f(pc.k)});`);
  });
  return lines.join("\n  ");
}

/**
 * `p` is in body space; the head pieces read `ph`, the point carried into the head's own frame (so the head turns
 * while the neck stays). `breath` lifts the shoulders and fills the chest a little.
 */
export const SDF_GLSL = /* glsl */ `
float sminA(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float ellA(vec3 p, vec3 c, vec3 r) {
  vec3 q = p - c;
  float k0 = length(q / r);
  float k1 = length(q / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float coneA(vec3 p, vec3 a, vec3 b, float r0, float r1) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(r0, r1, h);
}
float headSdf(vec3 ph) {
  vec3 qh = vec3(sqrt(ph.x * ph.x + ${f(HEAD_FOLD)}), ph.yz);
  ${glslGroup("h", PIECES.head, "ph")}
  return h;
}
/* parts: x torso, y neck and shoulders, z arms, w head */
float auraSdf(vec3 p, vec3 ph, float breath, out vec4 parts) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  vec3 lift = vec3(0.0, 0.008 * breath, 0.0);
  vec3 fill = vec3(1.0, 1.0, 1.0 + 0.012 * breath);
  ${glslGroup("torso", PIECES.torso, "p")}
  ${glslGroup("neck", PIECES.neck, "p")}
  ${glslGroup("arm", PIECES.arm, "p")}
  float head = headSdf(ph);
  parts = vec4(torso, neck, arm, head);
  float body = sminA(torso, neck, ${f(JOIN.neck)});
  body = sminA(body, arm, ${f(JOIN.arm)});
  return sminA(body, head, ${f(JOIN.head)});
}
const vec3 PIVOT = ${v(PIVOT)};
const vec3 HEART = ${v(HEART)};
const vec3 FACE = ${v(FACE)};
`;

/* ---------------- hair ---------------- */

export interface HairGuides {
  /** Points per guide. */
  points: number;
  /** Number of guides. */
  count: number;
  /** count × points × 4 floats: x, y, z, and the guide's group (strands blend only inside one group). */
  data: Float32Array;
  /** First guide index of every group, plus the end. */
  groups: number[];
  /** Per guide: 1 when it falls in front of the shoulder, 0 behind. */
  front: Float32Array;
}

/** The side parting sits a little to the figure's left (+x on screen). */
export const PART_X = 0.1;

/**
 * Hair guides. Roots run along a soft side parting from the forehead hairline back over the crown. From there the
 * strands are combed over the skull with real thickness (more at the crown), leave the face's hairline free, wrap
 * the temples and fall in soft waves: the front locks over the collarbones, the rest behind the shoulders, pushed
 * out of the body wherever they would cut into it. Three layers give the volume. Deterministic.
 */
export function buildHairGuides(perRow = 36, points = 36): HairGuides {
  const layers = [0.025, 0.055, 0.085, 0.12];
  const count = 2 * layers.length * perRow;
  const data = new Float32Array(count * points * 4);
  const front = new Float32Array(count);
  const groups: number[] = [];
  const cc = PIECES.head[0]!.s as { c: V3 };
  let g = 0;
  for (let side = -1; side <= 1; side += 2)
    for (let li = 0; li < layers.length; li++) {
      groups.push(g);
      for (let i = 0; i < perRow; i++, g++) {
        const u = i / (perRow - 1);
        // Along the parting: from the hairline above the forehead, over the crown, to the back of the head.
        const beta = 1.2 - u * 2.95;
        let dx = PART_X * 2.2;
        let dy = Math.cos(beta);
        let dz = Math.sin(beta);
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        let px = cc.c[0];
        let py = cc.c[1];
        let pz = cc.c[2];
        for (let s = 0; s < 120; s++) {
          const d = headField(px, py, pz);
          if (d > -0.001) break;
          px += dx * Math.max(0.003, -d);
          py += dy * Math.max(0.003, -d);
          pz += dz * Math.max(0.003, -d);
        }
        // Volume: thicker at the crown, close to the skull at the hairline.
        const crown = Math.max(0, Math.min(1, (py - 0.55) / 0.45));
        const off = layers[li]! * (0.75 + 0.9 * crown);
        {
          const n = gradient(headField, px, py, pz);
          px += n[0] * off;
          py += n[1] * off;
          pz += n[2] * off;
        }
        // The long side of the parting sweeps over the top of the head; the short side drops sooner.
        const long = side < 0 ? 1 : 0.8;
        const length =
          (2.7 + 0.6 * u + 0.14 * Math.sin(i * 2.3 + li * 1.7)) * long;
        const step = length / (points - 1);
        const inFront = u < 0.17 && (li === 1 || li === 2) ? 1 : 0;
        front[g] = inFront;
        const phase = i * 0.9 + li * 2.1 + (side > 0 ? 1.3 : 0);
        // Combed out of the parting toward the side and a little back, so the forehead keeps a hairline.
        const frame = Math.max(0, 1 - u / 0.22) * (side < 0 ? 0.2 : 0.55);
        dx = side * (1 - 0.25 * frame);
        // The front of the hairline is combed sideways first, so it clears the face before it falls.
        dy = -0.12 - 0.75 * u - 0.3 * frame;
        dz = (-0.35 * (1 - u) - 0.2 * u) * (1 - frame) + 0.04 * frame;
        for (let k = 0; k < points; k++) {
          const o = (g * points + k) * 4;
          data[o] = px;
          data[o + 1] = py;
          data[o + 2] = pz;
          data[o + 3] = groups.length - 1;
          const fall = k < 5 ? 0.1 : 0.2;
          const below = py < 0.3;
          // Soft waves once the hair leaves the head; the front locks come forward over the collarbones.
          const wave = below ? 0.09 * Math.sin(k * 0.55 + phase) : 0;
          dx =
            dx * (1 - fall) +
            side * (below ? 0.004 + 0.01 * li : 0) +
            wave * side;
          dy = dy * (1 - fall) - fall;
          dz =
            dz * (1 - fall) +
            (below ? (inFront ? 0.05 : -0.025) : 0) +
            (below ? 0.5 * wave * Math.cos(k * 0.4 + phase) : 0);
          // Near the head, follow its surface instead of cutting into it.
          const dh = headField(px, py, pz);
          if (dh < off + 0.05) {
            const n = gradient(headField, px, py, pz);
            const dn = dx * n[0] + dy * n[1] + dz * n[2];
            if (dn < 0) {
              dx -= dn * n[0];
              dy -= dn * n[1];
              dz -= dn * n[2];
            }
          }
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l;
          dy /= l;
          dz /= l;
          px += dx * step;
          py += dy * step;
          pz += dz * step;
          // On the skull the hair lies on it at its own thickness (it sits ON the head, it does not float).
          if (py > 0.32) {
            const dh2 = headField(px, py, pz);
            if (dh2 > off) {
              const n = gradient(headField, px, py, pz);
              const pull = Math.min(dh2 - off, 0.06);
              px -= n[0] * pull;
              py -= n[1] * pull;
              pz -= n[2] * pull;
            }
          }
          const keep = Math.min(off, 0.05) + 0.012 + 0.02 * (k / points);
          for (let it = 0; it < 3; it++) {
            const d = auraField(px, py, pz);
            if (d >= keep) break;
            const n = gradient(auraField, px, py, pz);
            px += n[0] * (keep - d);
            py += n[1] * (keep - d);
            pz += n[2] * (keep - d);
          }
        }
      }
    }
  groups.push(g);
  return { points, count, data, groups, front };
}

/* ---------------- framing and timing ---------------- */

/** Visible height of the scene at the figure's plane for a viewport aspect. */
export function auraViewHeight(aspect: number): number {
  // A bust portrait. 16:9: the head (chin to crown) takes about 43% of the height and the frame ends at the upper
  // chest; narrow screens
  // widen the view so both shoulders (about 1.8 heads) keep some air.
  return Math.max(2.35, 1.9 / Math.max(0.2, aspect));
}

/** Camera target height so the crown sits `top` (share of the screen) below the top edge. */
export function auraCameraY(aspect: number, top = 0.08): number {
  const vh = auraViewHeight(aspect);
  return CROWN + top * vh - vh / 2;
}

/** Easing for the weave: quick start from the heart, long settle at the fingertips of the hair. */
export function weaveEase(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return 1 - Math.pow(1 - c, 2.2);
}

/** The weave front: starts slowly at the heart, spreads, and lands softly on the last strand tip. */
export function weaveFront(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}
