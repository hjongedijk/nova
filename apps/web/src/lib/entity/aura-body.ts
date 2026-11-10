/**
 * AURA's body, as numbers. One signed distance field describes the figure (head, long neck, sloping shoulders,
 * upper arms, a torso narrowing to the waist). The same primitives are written out as GLSL for the ray-marched
 * surface (aura-shaders.ts), and evaluated here in JS to grow the hair guides over the scalp and shoulders and to
 * test the proportions.
 *
 * Units: the chin sits near y = 0, the crown at y = CROWN; x to the figure's left on screen is negative, +z
 * faces the viewer. The figure is mirror symmetric in x.
 */

export type V3 = readonly [number, number, number];

/** Primitives (right half; the left is mirrored through |x|). */
export const P = {
  cranium: { c: [0, 0.74, -0.06], r: [0.41, 0.56, 0.5] },
  face: { c: [0, 0.42, 0.07], r: [0.28, 0.46, 0.36] },
  chin: { c: [0, 0.1, 0.13], r: [0.13, 0.16, 0.2] },
  /* A mask, not a portrait: a nose ridge, a soft brow, cheekbones and shallow eye hollows, so a turn reads. */
  nose: { c: [0, 0.43, 0.4], r: [0.038, 0.15, 0.07] },
  brow: { c: [0, 0.63, 0.32], r: [0.25, 0.065, 0.1] },
  cheek: { c: [0.16, 0.39, 0.3], r: [0.1, 0.07, 0.08] },
  eye: { c: [0.125, 0.55, 0.5], r: 0.1 },
  neck: { a: [0, 0.36, -0.1], b: [0, -0.8, -0.07], r0: 0.17, r1: 0.215 },
  trap: { a: [0.16, -0.66, -0.15], b: [0.94, -1.16, -0.11], r: 0.14 },
  delt: { c: [1.04, -1.36, -0.07], r: [0.23, 0.29, 0.23] },
  arm: { a: [1.08, -1.4, -0.07], b: [1.32, -5.2, -0.1], r0: 0.18, r1: 0.125 },
  chest: { c: [0, -1.55, -0.08], r: [0.88, 0.84, 0.4] },
  ribs: { c: [0, -2.6, -0.07], r: [0.74, 1.22, 0.35] },
  hips: { c: [0, -4.0, -0.05], r: [0.9, 0.95, 0.39] },
  breast: { c: [0.43, -1.98, 0.17], r: [0.34, 0.32, 0.27] },
  clav: { a: [0.07, -0.86, 0.15], b: [0.74, -0.95, 0.04], r: 0.022 },
} as const;

/** The head turns about the top of the neck. */
export const PIVOT: V3 = [0, 0.1, -0.08];
/** Where the weave starts (the heart, under the sternum) and where the state bloom spreads from (the face). */
export const HEART: V3 = [0, -1.72, 0.32];
export const FACE: V3 = [0, 0.5, 0.42];
export const CROWN = 1.3;
export const CHIN = 0.0;
/** The weave is complete once its front has passed every point of the body by this distance. */
export const WEAVE_REACH = 5.6;

const BLEND = {
  head: 0.22,
  torso: 0.5,
  breast: 0.13,
  trap: 0.22,
  neckHead: 0.12,
  neckTorso: 0.2,
  armDelt: 0.14,
  armBody: 0.09,
  clav: 0.1,
  chin: 0.16,
  feature: 0.08,
  eye: 0.12,
} as const;

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function ellipsoid(
  x: number,
  y: number,
  z: number,
  c: readonly number[],
  r: readonly number[],
): number {
  const px = x - c[0]!;
  const py = y - c[1]!;
  const pz = z - c[2]!;
  const k0 = Math.hypot(px / r[0]!, py / r[1]!, pz / r[2]!);
  const k1 = Math.hypot(
    px / (r[0]! * r[0]!),
    py / (r[1]! * r[1]!),
    pz / (r[2]! * r[2]!),
  );
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0]!, r[1]!, r[2]!);
}

function cone(
  x: number,
  y: number,
  z: number,
  a: readonly number[],
  b: readonly number[],
  r0: number,
  r1: number,
): number {
  const pax = x - a[0]!;
  const pay = y - a[1]!;
  const paz = z - a[2]!;
  const bax = b[0]! - a[0]!;
  const bay = b[1]! - a[1]!;
  const baz = b[2]! - a[2]!;
  const h = Math.max(
    0,
    Math.min(
      1,
      (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
    ),
  );
  return (
    Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) -
    (r0 + (r1 - r0) * h)
  );
}

/** The head alone (cranium and face), in rest pose. */
export function headField(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let h = smin(
    smin(
      ellipsoid(x, y, z, P.cranium.c, P.cranium.r),
      ellipsoid(x, y, z, P.face.c, P.face.r),
      BLEND.head,
    ),
    ellipsoid(x, y, z, P.chin.c, P.chin.r),
    BLEND.chin,
  );
  h = smin(h, ellipsoid(x, y, z, P.nose.c, P.nose.r), BLEND.feature);
  h = smin(h, ellipsoid(x, y, z, P.brow.c, P.brow.r), BLEND.feature);
  h = smin(h, ellipsoid(ax, y, z, P.cheek.c, P.cheek.r), BLEND.feature);
  const eye =
    Math.hypot(ax - P.eye.c[0], y - P.eye.c[1], z - P.eye.c[2]) - P.eye.r;
  return -smin(-h, eye, BLEND.eye);
}

/** The whole figure, rest pose: negative inside. */
export function auraField(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let torso = smin(
    ellipsoid(ax, y, z, P.chest.c, P.chest.r),
    ellipsoid(ax, y, z, P.ribs.c, P.ribs.r),
    BLEND.torso,
  );
  torso = smin(torso, ellipsoid(ax, y, z, P.hips.c, P.hips.r), BLEND.torso);
  torso = smin(
    torso,
    ellipsoid(ax, y, z, P.breast.c, P.breast.r),
    BLEND.breast,
  );
  let body = smin(
    torso,
    cone(ax, y, z, P.trap.a, P.trap.b, P.trap.r, P.trap.r),
    BLEND.trap,
  );
  body = smin(
    body,
    cone(ax, y, z, P.clav.a, P.clav.b, P.clav.r, P.clav.r),
    BLEND.clav,
  );
  const neck = cone(ax, y, z, P.neck.a, P.neck.b, P.neck.r0, P.neck.r1);
  body = smin(body, neck, BLEND.neckTorso);
  const arm = smin(
    ellipsoid(ax, y, z, P.delt.c, P.delt.r),
    cone(ax, y, z, P.arm.a, P.arm.b, P.arm.r0, P.arm.r1),
    BLEND.armDelt,
  );
  body = smin(body, arm, BLEND.armBody);
  return smin(body, headField(x, y, z), BLEND.neckHead);
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

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const v = (a: readonly number[]) => `vec3(${a.map(f).join(", ")})`;

/**
 * The same field in GLSL. `p` is in body space; the head primitives read `ph`, the point carried into the head's
 * own frame (so the head turns while the neck stays). `uBreath` lifts the shoulders and fills the chest a little.
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
  float h = sminA(ellA(ph, ${v(P.cranium.c)}, ${v(P.cranium.r)}),
                  ellA(ph, ${v(P.face.c)}, ${v(P.face.r)}), ${f(BLEND.head)});
  h = sminA(h, ellA(ph, ${v(P.chin.c)}, ${v(P.chin.r)}), ${f(BLEND.chin)});
  vec3 pa = vec3(abs(ph.x), ph.yz);
  h = sminA(h, ellA(ph, ${v(P.nose.c)}, ${v(P.nose.r)}), ${f(BLEND.feature)});
  h = sminA(h, ellA(ph, ${v(P.brow.c)}, ${v(P.brow.r)}), ${f(BLEND.feature)});
  h = sminA(h, ellA(pa, ${v(P.cheek.c)}, ${v(P.cheek.r)}), ${f(BLEND.feature)});
  float eye = length(pa - ${v(P.eye.c)}) - ${f(P.eye.r)};
  return -sminA(-h, eye, ${f(BLEND.eye)});
}
/* groups: x torso, y neck+shoulders, z arms, w head */
float auraSdf(vec3 p, vec3 ph, float breath, out vec4 parts) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  vec3 qs = q - vec3(0.0, 0.012 * breath, 0.0);
  float fill = 1.0 + 0.012 * breath;
  float torso = sminA(ellA(q, ${v(P.chest.c)}, ${v(P.chest.r)} * vec3(1.0, 1.0, fill)),
                      ellA(q, ${v(P.ribs.c)}, ${v(P.ribs.r)}), ${f(BLEND.torso)});
  torso = sminA(torso, ellA(q, ${v(P.hips.c)}, ${v(P.hips.r)}), ${f(BLEND.torso)});
  torso = sminA(torso, ellA(q, ${v(P.breast.c)}, ${v(P.breast.r)} * fill), ${f(BLEND.breast)});
  float trap = coneA(qs, ${v(P.trap.a)}, ${v(P.trap.b)}, ${f(P.trap.r)}, ${f(P.trap.r)});
  float clav = coneA(qs, ${v(P.clav.a)}, ${v(P.clav.b)}, ${f(P.clav.r)}, ${f(P.clav.r)});
  float neck = coneA(q, ${v(P.neck.a)}, ${v(P.neck.b)}, ${f(P.neck.r0)}, ${f(P.neck.r1)});
  float arm = sminA(ellA(qs, ${v(P.delt.c)}, ${v(P.delt.r)}),
                    coneA(qs, ${v(P.arm.a)}, ${v(P.arm.b)}, ${f(P.arm.r0)}, ${f(P.arm.r1)}), ${f(BLEND.armDelt)});
  float head = headSdf(ph);
  parts = vec4(torso, min(trap, neck), arm, head);
  float body = sminA(torso, trap, ${f(BLEND.trap)});
  body = sminA(body, clav, ${f(BLEND.clav)});
  body = sminA(body, neck, ${f(BLEND.neckTorso)});
  body = sminA(body, arm, ${f(BLEND.armBody)});
  return sminA(body, head, ${f(BLEND.neckHead)});
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
}

/**
 * Hair guides: from a centre parting, strands comb sideways over the scalp, are turned down by gravity, wrap the
 * sides of the head and fall past the shoulders, pushed out of the body wherever they would cut into it. Three
 * layers at increasing distance from the scalp give the hair its volume. Deterministic.
 */
export function buildHairGuides(perRow = 30, points = 32): HairGuides {
  const layers = [0.014, 0.05, 0.095];
  const count = 2 * layers.length * perRow;
  const data = new Float32Array(count * points * 4);
  const groups: number[] = [];
  const cc = P.cranium.c;
  let g = 0;
  for (let side = -1; side <= 1; side += 2)
    for (let li = 0; li < layers.length; li++) {
      groups.push(g);
      const off = layers[li]!;
      for (let i = 0; i < perRow; i++, g++) {
        const u = i / (perRow - 1);
        // Along the parting: from the front hairline over the crown to the back of the head.
        const beta = 0.55 - u * 2.35;
        let dx = side * 0.05;
        let dy = Math.cos(beta);
        let dz = Math.sin(beta);
        // March out of the head to its surface.
        let px = cc[0];
        let py = cc[1];
        let pz = cc[2];
        for (let s = 0; s < 80; s++) {
          const d = headField(px, py, pz);
          if (d > -0.001) break;
          px += dx * Math.max(0.004, -d);
          py += dy * Math.max(0.004, -d);
          pz += dz * Math.max(0.004, -d);
        }
        {
          const n = gradient(headField, px, py, pz);
          px += n[0] * off;
          py += n[1] * off;
          pz += n[2] * off;
        }
        const length = 2.75 + 0.55 * u + 0.12 * Math.sin(i * 2.3 + li);
        const step = length / (points - 1);
        // Combed sideways out of the parting, a little backward toward the crown.
        // The back of the head falls nearly straight: that hair shows behind the neck.
        dx = side * (1 - 0.75 * u * u);
        dy = -0.25 - 0.5 * u;
        dz = -0.2 * u;
        for (let k = 0; k < points; k++) {
          const o = (g * points + k) * 4;
          data[o] = px;
          data[o + 1] = py;
          data[o + 2] = pz;
          data[o + 3] = groups.length - 1;
          // Gravity turns the strand down; below the ears it spreads slightly outward for volume.
          const fall = k < 4 ? 0.1 : 0.22;
          dx = dx * (1 - fall) + side * (py < 0.4 ? 0.025 + 0.03 * li : 0);
          dy = dy * (1 - fall) - fall;
          dz = dz * (1 - fall) - (py < 0.3 ? 0.012 : 0);
          // Near the head, follow its surface instead of leaving it.
          const dh = headField(px, py, pz);
          if (dh < off + 0.06) {
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
          // Never inside the body: push out along the field's gradient (drapes over the shoulders).
          const keep = off + 0.012 + 0.03 * (k / points);
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
  return { points, count, data, groups };
}

/** Visible height of the scene at the figure's plane for a viewport aspect: crown in the upper part, chest below. */
export function auraViewHeight(aspect: number): number {
  // 1080p: the head (crown to chin) takes about a third of the height; narrow screens widen the view so both
  // shoulders (about 3 units with the arms) keep some air.
  return Math.max(3.95, 3.3 / Math.max(0.2, aspect));
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
