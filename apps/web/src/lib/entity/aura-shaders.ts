import { P, SDF_GLSL, WEAVE_REACH } from "./aura-body.ts";

/**
 * AURA shaders. Linear colour throughout; tone mapping and sRGB happen in the output pass.
 *
 * - BG: smoke (domain-warped fbm), sparse stars and a few long ribbons, drawn first, full screen.
 * - BODY: a bounded quad in front of the figure; each pixel ray-marches the distance field, shades a dark glossy
 *   skin with contour strokes, rim light and inner sparkle, and writes its real depth so hair and motes sort.
 * - HAIR: line strands interpolated between CPU-grown guides on the GPU, swaying.
 * - MOTES: drifting points.
 * - POST: vignette, grain, the reply floor.
 */

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

const COMMON = /* glsl */ `
uniform float uT;
uniform float uMotion;
uniform float uWeave;
uniform float uWaveR;
uniform float uWaveEdge;
uniform float uAudio;
uniform float uPulse;
uniform float uGlow;
uniform vec3 uA0; uniform vec3 uA1;
uniform vec3 uB0; uniform vec3 uB1;
uniform vec3 uR0; uniform vec3 uR1;
uniform vec3 uF0; uniform vec3 uF1;
uniform vec3 uH0; uniform vec3 uH1;
uniform mat3 uHead;
uniform mat3 uHeadInv;
uniform float uBreath;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
${SDF_GLSL}
/* The state bloom: inside the growing radius around the face the new look, outside still the old one. */
float waveK(vec3 p) {
  float d = length(p - FACE);
  return 1.0 - smoothstep(uWaveR - 0.9, uWaveR, d);
}
float waveRing(vec3 p) {
  return uWaveEdge * exp(-abs(length(p - FACE) - uWaveR) * 2.6);
}
`;

/* ---------------- background ---------------- */

export const BG_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

export const BG_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform float uT;
uniform float uMotion;
uniform float uWeave;
uniform vec3 uBg0;
uniform vec3 uBg1;
uniform vec3 uSmoke;
uniform vec3 uRibbon;
uniform vec3 uStar;
uniform vec2 uCenter;
uniform vec3 uAuraC;
uniform vec2 uPar;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

/* One ribbon: a long curve whose width breathes along its length, as if a silk band twists in the light. */
float ribbon(vec2 p, float px, float c, float a1, float f1, float ph1, float a2, float f2, float ph2, float wid, float tw) {
  float y = c + a1 * sin(p.x * f1 + ph1) + a2 * sin(p.x * f2 + ph2);
  float dy = a1 * f1 * cos(p.x * f1 + ph1) + a2 * f2 * cos(p.x * f2 + ph2);
  float d = abs(p.y - y) / sqrt(1.0 + dy * dy);
  float w = wid * (0.15 + 0.85 * pow(abs(sin(p.x * tw + ph2 * 0.7)), 1.6));
  float edge = exp(-abs(d - w) / (1.1 * px));
  float fill = (1.0 - smoothstep(0.0, w + px, d)) * 0.22;
  float glow = exp(-d / (w * 2.0 + 6.0 * px)) * 0.18;
  return edge * 0.55 + fill + glow;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float px = 1.0 / uRes.y;
  float tt = uT * uMotion;

  vec3 col = mix(uBg1, uBg0, smoothstep(-0.2, 1.1, uv.y + 0.15 * (1.0 - abs(p.x))));

  /* smoke: slow, warped, mostly at the sides and the top */
  vec2 q = p * 1.7 + uPar * 0.04;
  vec2 w = vec2(fbm(q + vec2(0.0, tt * 0.012)), fbm(q + vec2(5.2, 1.3) - tt * 0.01));
  float s = fbm(q * 1.15 + w * 1.7 + vec2(tt * 0.006, 0.0));
  float wisps = smoothstep(0.42, 0.95, s);
  float edges = 0.55 + 0.45 * smoothstep(0.15, 0.75, abs(p.x));
  col += uSmoke * (wisps * 1.3 + pow(wisps, 3.0) * 1.8) * edges;
  /* thin filaments inside the smoke */
  float fil = abs(fract(s * 9.0) - 0.5);
  col += uSmoke * 0.35 * (1.0 - smoothstep(0.0, 0.08, fil)) * wisps;

  /* an aura of light behind the figure */
  vec2 dc = (p - uCenter) * vec2(1.0, 0.8);
  col += uAuraC * (exp(-dot(dc, dc) * 4.0) * 0.55 + exp(-dot(dc, dc) * 1.2) * 0.25) * uWeave;

  /* sparse stars, some of them twinkling */
  vec2 sg = gl_FragCoord.xy / 3.0;
  vec2 cell = floor(sg / 9.0);
  float h = hash12(cell);
  if (h > 0.93) {
    vec2 o = (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) * 0.8 + 0.1) * 9.0;
    float d = length(sg - cell * 9.0 - o);
    float tw = 0.55 + 0.45 * sin(tt * (0.6 + 2.0 * fract(h * 37.0)) + h * 40.0);
    col += uStar * (1.0 - smoothstep(0.0, 1.0, d)) * tw * (h - 0.93) * 14.0;
  }

  /* ribbons sweeping across the frame */
  float r = 0.0;
  float ts = tt * 0.03;
  r += ribbon(p, px, 0.12, 0.22, 1.6, 0.6 + ts, 0.07, 3.1, 1.7 - ts * 1.3, 0.010, 1.2) * 0.9;
  r += ribbon(p, px, -0.18, 0.18, 1.2, 2.4 - ts, 0.05, 2.7, 0.4 + ts, 0.007, 1.7) * 0.7;
  r += ribbon(p, px, 0.33, 0.12, 2.1, 4.1 + ts * 0.7, 0.04, 4.3, 2.2, 0.005, 2.3) * 0.5;
  r += ribbon(p, px, -0.38, 0.1, 1.9, 5.3 - ts * 0.5, 0.05, 3.7, 3.3 + ts, 0.006, 1.4) * 0.45;
  float fadeX = smoothstep(0.0, 0.25, uv.x) * (1.0 - smoothstep(0.75, 1.0, uv.x)) * 0.6 + 0.4;
  col += uRibbon * r * fadeX * (0.35 + 0.35 * wisps);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- body ---------------- */

export const BODY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const ARM_A = `vec3(${P.arm.a.map(f).join(", ")})`;
const ARM_B = `vec3(${P.arm.b.map(f).join(", ")})`;
const BREAST_C = `vec2(${f(P.breast.c[0])}, ${f(P.breast.c[1])})`;

export const BODY_FRAG = /* glsl */ `
${COMMON}
varying vec3 vWorld;
uniform mat4 uPV;
uniform float uPixAngle;
uniform vec3 uKey;

float mapD(vec3 p) {
  vec4 parts;
  vec3 ph = uHeadInv * (p - PIVOT) + PIVOT;
  return auraSdf(p, ph, uBreath, parts);
}
vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0016;
  return normalize(k.xyy * mapD(p + k.xyy * e) + k.yyx * mapD(p + k.yyx * e) +
                   k.yxy * mapD(p + k.yxy * e) + k.xxx * mapD(p + k.xxx * e));
}

/* Stroke families: scalar fields whose level lines follow the form. */
float psiTorso(vec3 q) {
  // Chevrons rising from the sternum toward the shoulders, bent into contours around the breasts.
  float ax = sqrt(q.x * q.x + 0.006);
  return q.y - 0.82 * ax * (1.0 - 0.12 * ax);
}
float psiBreast(vec3 q) {
  // Contours around the breast, slightly open toward the sternum.
  vec2 b = (q.xy - ${BREAST_C}) * vec2(1.0, 1.05);
  return length(b) + 0.06 * b.x;
}
float psiCap(vec3 q) {
  // Arcs over the round of the shoulder, centred near the armpit so they follow the outline.
  return length((q.xy - vec2(0.8, -1.72)) * vec2(1.0, 0.92));
}
float psiNeck(vec3 q) {
  float flare = clamp((-0.42 - q.y) / 0.55, 0.0, 1.0);
  float w = 0.2 + 0.85 * flare * flare;
  float neckLines = q.x / w;
  // On the shoulders the lines turn parallel to the slope of the trapezius.
  float slope = (q.y + 0.43 * q.x) * 3.2;
  return mix(neckLines * 2.2, slope, smoothstep(0.22, 0.5, q.x));
}
float psiArm(vec3 q) {
  float h = clamp((q.y - ${ARM_A}.y) / (${ARM_B}.y - ${ARM_A}.y), 0.0, 1.0);
  vec3 axis = mix(${ARM_A}, ${ARM_B}, h);
  float th = atan(q.z - axis.z, q.x - axis.x);
  return th * 7.0 / 6.2831853 + 0.55 * q.y;
}
float psiHead(vec3 qh) {
  return qh.x * 8.0 + 0.6 * qh.y * qh.x;
}

/* One family's contribution: colour of its lines at this point. */
vec3 strokes(float psi, vec3 grad, vec3 n, float freq, float foot, float fam, vec3 p, vec3 A, vec3 B, float pulseDir, float detail) {
  float u = psi * freq;
  vec3 gt = grad - n * dot(n, grad);
  float fw = max(length(gt) * freq * foot, 1e-4);
  float d = abs(fract(u + 0.5) - 0.5) / fw;
  float idx = floor(u + 0.5);
  float h = hash11(idx * 7.13 + fam * 31.7);
  float core = clamp(1.0 - d / (1.0 + 1.5 * h * h), 0.0, 1.0);
  float halo = exp(-d * 0.2) * 0.3;
  // Lines closer than a few pixels fade instead of aliasing into grey.
  float resolve = 1.0 - smoothstep(0.1, 0.32, fw);
  // Broken into strokes of different lengths, some brighter, some amber.
  float seg = vnoise3(p * vec3(1.3, 2.1, 1.3) + vec3(idx * 1.37 + fam * 5.1));
  float keep = mix(smoothstep(0.28, 0.62, seg), 1.0, 0.18 + 0.5 * step(0.8, h));
  float travel = pow(0.5 + 0.5 * sin(pulseDir * 4.0 - uT * uPulse * uMotion * 1.6 + h * 40.0), 14.0);
  vec3 c = mix(A, B, step(0.7, h) * 0.9 + 0.1 * smoothstep(0.4, 1.0, seg));
  float bright = (0.22 + 1.25 * h * h * h) * keep * (1.0 + 1.2 * travel);
  return c * (core * 2.6 + halo) * bright * resolve * detail;
}

#define GRAD(fn, q, e) vec3(fn(q + vec3(e, 0, 0)) - fn(q - vec3(e, 0, 0)), fn(q + vec3(0, e, 0)) - fn(q - vec3(0, e, 0)), fn(q + vec3(0, 0, e)) - fn(q - vec3(0, 0, e))) / (2.0 * e)

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 p = vWorld;
  float t = 0.0;
  bool hit = false;
  float dmin = 1e9;
  float tmin = 0.0;
  for (int i = 0; i < 80; i++) {
    float d = mapD(p);
    if (d < 0.0012) { hit = true; break; }
    if (d < dmin) { dmin = d; tmin = t; }
    t += d * 0.9;
    p = vWorld + rd * t;
    if (t > 2.6) break;
  }
  // A ray that grazes the silhouette counts as a partial hit: smooth edges instead of a dotted rim.
  float cover = 1.0;
  if (!hit) {
    float edge = 2.0 * length(vWorld + rd * tmin - cameraPosition) * uPixAngle;
    if (dmin > edge) discard;
    t = tmin;
    p = vWorld + rd * t;
    cover = 1.0 - dmin / edge;
  }

  vec4 parts;
  vec3 ph = uHeadInv * (p - PIVOT) + PIVOT;
  auraSdf(p, ph, uBreath, parts);
  vec3 n = calcNormal(p);
  vec3 nh = uHeadInv * n;
  vec3 v = -rd;
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fres = 1.0 - ndv;
  float foot = length(p - ro) * uPixAngle * (1.0 + 1.2 * fres);

  float wk = waveK(p);
  vec3 A = mix(uA0, uA1, wk);
  vec3 B = mix(uB0, uB1, wk);
  vec3 R = mix(uR0, uR1, wk);
  vec3 F = mix(uF0, uF1, wk);
  float ring = waveRing(p);

  /* birth: woven from the heart outward */
  float front = uWeave * ${f(WEAVE_REACH)};
  float dH = length(p - HEART);
  float lineOn = (1.0 - smoothstep(front - 0.35, front + 0.05, dH));
  float fillOn = (1.0 - smoothstep(front - 1.1, front - 0.25, dH));
  // One-sided: sharp ahead of the front (no ghost of the unwoven body), a short trail behind it.
  float weaveEdge = exp(-max(dH - front, 0.0) * 22.0 - max(front - dH, 0.0) * 6.0) * (1.0 - uWeave) * smoothstep(0.0, 0.04, uWeave);
  float bottom = smoothstep(-4.3, -3.0, p.y);

  /* which part of the body: soft weights */
  vec4 wpart = exp(-max(parts, 0.0) * 22.0);
  wpart /= max(1e-4, wpart.x + wpart.y + wpart.z + wpart.w);

  vec3 q = vec3(abs(p.x), p.y, p.z);
  vec3 qh = ph;
  float warp = (vnoise3(p * 1.6 + vec3(0.0, 0.0, uT * 0.05 * uMotion)) - 0.5) * 0.09;
  // A slower, larger bend so the chevrons flow instead of standing in rows.
  float bend = (vnoise3(vec3(q.x * 0.9, q.y * 0.75, q.z) + 11.0) - 0.5) * 0.42;
  vec3 lines = vec3(0.0);
  const float E = 0.004;
  float detail = 1.0;
  if (wpart.x > 0.01) {
    float psi = psiTorso(q) + warp + bend;
    vec3 g = GRAD(psiTorso, q, E);
    g.x *= sign(p.x + 1e-5);
    // Around the breast only a few contour arcs on its underside and outer side; no rings at its centre.
    vec2 bq = (q.xy - ${BREAST_C}) * vec2(1.0, 1.05);
    float br = length(bq);
    float wb = smoothstep(0.15, 0.22, br) * (1.0 - smoothstep(0.38, 0.47, br));
    wb *= (1.0 - smoothstep(-0.08, 0.12, bq.y - 0.7 * bq.x)) * step(0.1, q.x);
    float hush = 1.0 - (1.0 - smoothstep(0.1, 0.26, br)) * 0.85;
    vec3 chev = strokes(psi, g, n, 3.5, foot, 1.0, p, A, B, abs(p.x) * 2.2 - p.y * 0.3, detail)
              + strokes(psi + 0.11, g, n, 10.5, foot, 2.0, p, A, B * 0.8, -p.y, 0.16);
    chev *= hush;
    float pb = psiBreast(q) + warp * 0.5;
    vec3 gb = GRAD(psiBreast, q, E);
    gb.x *= sign(p.x + 1e-5);
    vec3 rings = strokes(pb, gb, n, 9.0, foot, 8.0, p, A, B, atan(q.y - ${BREAST_C}.y, q.x - ${BREAST_C}.x), detail);
    lines += wpart.x * mix(chev, rings, wb);
  }
  if (wpart.y > 0.01) {
    float psi = psiNeck(q) + warp;
    vec3 g = GRAD(psiNeck, q, E);
    g.x *= sign(p.x + 1e-5);
    lines += wpart.y * strokes(psi, g, n, 1.0, foot, 3.0, p, A, B, -p.y, detail);
    lines += wpart.y * strokes(psi * 2.6 + 0.3, g * 2.6, n, 1.0, foot, 4.0, p, A, B, p.y, 0.3);
  }
  if (wpart.z > 0.01) {
    float psi = psiArm(q) + warp * 3.0;
    vec3 g = GRAD(psiArm, q, E);
    g.x *= sign(p.x + 1e-5);
    vec3 along = strokes(psi, g, n, 1.0, foot, 5.0, p, A, B, p.y, detail)
               + strokes(psi * 2.8 + 0.4, g * 2.8, n, 1.0, foot, 6.0, p, A, B, -p.y, 0.3);
    float pc = psiCap(q) + warp * 0.5;
    vec3 gc = GRAD(psiCap, q, E);
    gc.x *= sign(p.x + 1e-5);
    vec3 cap = strokes(pc, gc, n, 7.0, foot, 9.0, p, A, B, q.x - q.y, detail);
    float wcap = smoothstep(-1.85, -1.3, q.y);
    lines += wpart.z * mix(along, cap, wcap);
  }
  if (wpart.w > 0.01) {
    // The face stays a smooth mask: lines only at the sides of the head.
    float side = smoothstep(0.75, 0.95, abs(nh.x)) * smoothstep(0.05, 0.4, qh.y);
    float psi = psiHead(qh) + warp;
    vec3 g = uHead * GRAD(psiHead, qh, E);
    lines += wpart.w * side * strokes(psi, g, n, 1.0, foot, 7.0, p, A, B, qh.y, 0.8);
  }

  /* the centre line down the face and the sternum */
  float cl = exp(-abs(qh.x) / max(foot * 1.4, 1e-4));
  float onFace = wpart.w * smoothstep(0.2, 0.6, nh.z) * smoothstep(0.45, 0.75, qh.y) * (1.0 - smoothstep(0.95, 1.2, qh.y)) * 0.6;
  float sternum = exp(-abs(p.x) / max(foot * 1.6, 1e-4)) * (1.0 - smoothstep(-1.15, -0.95, p.y)) * smoothstep(-2.6, -1.6, p.y) * wpart.x;
  lines += F * 0.22 * onFace * cl + A * 0.9 * sternum;

  /* skin: nearly black inside, glossy violet in the light, bright at the silhouette */
  vec3 L = normalize(uKey);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, normalize(L + v)), 0.0), 70.0) * (1.0 - 0.7 * wpart.w);
  vec3 base = vec3(0.004, 0.0015, 0.011) + A * (0.003 + 0.014 * diff * diff) * (1.0 - 0.5 * wpart.w) + R * spec * 0.2;
  base += A * pow(fres, 3.0) * 0.1;
  // Wide enough to cover a few pixels at the silhouette: a sub-pixel rim would flicker into dashes along
  // slanted edges (the stair steps of the pixel grid).
  vec3 rim = R * (pow(fres, 2.2) * 0.4 * (1.0 - 0.75 * wpart.w) + pow(fres, 4.0) * 0.8) + vec3(1.0, 0.93, 1.0) * pow(fres, 5.0) * 0.35;

  /* the face light: a soft glow on the forehead and the cheekbones, brightest in front */
  vec3 dfc = (qh - vec3(0.0, 0.62, 0.38)) * vec3(1.0, 0.7, 1.0);
  float faceLight = 0.13 * exp(-dot(dfc, dfc) / 0.07) * smoothstep(0.0, 0.7, nh.z) * wpart.w;

  /* a warm glow where the strokes meet, at the heart */
  vec3 dh = p - HEART - vec3(0.0, 0.25, 0.0);
  float heart = exp(-dot(dh, dh) / 0.06) * 0.35;

  /* starry interior: points just under the skin, with parallax */
  vec3 stars = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 27.0 : 43.0;
    vec3 pp = (p - n * (0.02 + 0.05 * float(k))) * sc;
    vec3 c = floor(pp);
    vec3 hh = hash33(c + float(k) * 19.0);
    float on = step(0.62, hh.x) * (k == 0 ? 1.0 : 0.7);
    float d = length(fract(pp) - (0.2 + 0.6 * hh));
    float tw = 0.55 + 0.45 * sin(uT * uMotion * (1.2 + 3.0 * hh.y) + hh.z * 6.2831);
    stars += on * (1.0 - smoothstep(0.0, 0.13, d)) * tw * mix(A, vec3(1.0, 0.82, 0.92), hh.y);
  }
  float starDensity = 0.35 + 0.65 * smoothstep(0.25, 0.7, vnoise3(p * 2.2 + 3.0)) * smoothstep(0.12, 0.4, ndv);

  float glow = uGlow * (1.0 + 1.1 * uAudio);
  // Lines bunch up where the skin turns away: let the rim own the silhouette. The waist stays quieter than the chest.
  lines *= smoothstep(0.06, 0.3, ndv) * (0.45 + 0.55 * smoothstep(-3.6, -2.3, p.y));
  vec3 lit = lines * glow * (1.0 + ring * 1.5);
  vec3 col = (base + rim * glow + F * faceLight * 0.9 * glow + (A + B) * 0.5 * heart * glow + stars * starDensity * 3.0) * fillOn;
  col += R * ring * pow(fres, 1.5) * 1.2 * fillOn;
  col += lit * lineOn;
  col += (A + B) * weaveEdge * 0.8;
  float alpha = fillOn * bottom * cover;
  col *= bottom * cover;

  vec4 clip = uPV * vec4(p, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/* ---------------- hair ---------------- */

export const HAIR_VERT = /* glsl */ `
${COMMON}
attribute vec4 aStrand;
uniform sampler2D uGuides;
uniform float uPoints;
varying vec3 vCol;
varying float vA;
void main() {
  ivec2 ia = ivec2(int(aStrand.w + 0.5), int(aStrand.x + 0.5));
  vec3 pa = texelFetch(uGuides, ia, 0).xyz;
  vec3 pb = texelFetch(uGuides, ia + ivec2(0, 1), 0).xyz;
  float seed = aStrand.z;
  float s = aStrand.w / (uPoints - 1.0);
  vec3 pos = mix(pa, pb, aStrand.y);
  vec3 h3 = hash33(vec3(seed * 91.7, seed * 13.3, seed * 47.1)) - 0.5;
  pos += h3 * vec3(0.05, 0.02, 0.05) * (0.15 + 1.2 * s);
  pos += vec3(sin(s * 8.0 + seed * 21.0), 0.0, cos(s * 6.0 + seed * 13.0)) * 0.014 * s;
  float sw = s * s * uMotion;
  pos.x += sw * (0.05 * sin(uT * 0.55 + seed * 6.2831 + pos.y * 1.2) + 0.018 * sin(uT * 1.35 + seed * 17.0));
  pos.z += sw * 0.035 * sin(uT * 0.42 + seed * 4.0 + pos.y);
  pos.y += uBreath * 0.01 * smoothstep(0.3, 0.8, s);
  float hw = 1.0 - 0.55 * smoothstep(0.25, 0.95, s);
  pos = mix(pos, uHead * (pos - PIVOT) + PIVOT, hw);

  float wk = waveK(pos);
  vec3 H = mix(uH0, uH1, wk);
  vec3 B = mix(uB0, uB1, wk);
  vec3 A = mix(uA0, uA1, wk);
  float hs = hash11(seed * 311.0);
  vec3 c = hs > 0.9 ? B : (hs > 0.55 ? A : H);
  float root = exp(-s * 9.0) * 0.6;
  float body = pow(1.0 - s, 0.8);
  float glint = 0.6 + 0.4 * sin(s * 18.0 - uT * uMotion * 0.6 * uPulse + seed * 50.0);
  float rev = (uWeave - 0.3) / 0.62 * 1.4 - seed * 0.3;
  float shown = (1.0 - smoothstep(rev - 0.06, rev, s));
  vCol = c * (0.7 + root) * (0.4 + 0.9 * hs * hs) * glint * uGlow * (1.0 + 0.7 * uAudio) * (1.0 + waveRing(pos));
  vA = (0.04 + 0.05 * hs + 0.22 * step(0.93, hs)) * body * shown * smoothstep(0.0, 0.02, s + 0.01);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

export const HAIR_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() { gl_FragColor = vec4(vCol * vA, 1.0); }
`;

/* ---------------- motes ---------------- */

export const MOTE_VERT = /* glsl */ `
${COMMON}
attribute vec4 aSeed;
uniform float uPx;
varying vec3 vCol;
void main() {
  vec3 pos = position;
  float tt = uT * uMotion;
  pos.y = mod(pos.y + 3.0 + tt * (0.02 + 0.05 * aSeed.x), 6.4) - 3.0 + 0.0;
  pos.x += 0.08 * sin(tt * 0.2 + aSeed.y * 6.2831) ;
  pos.z += 0.06 * cos(tt * 0.17 + aSeed.z * 6.2831);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  float wk = waveK(pos);
  vec3 A = mix(uA0, uA1, wk);
  vec3 B = mix(uB0, uB1, wk);
  float tw = 0.5 + 0.5 * sin(tt * (0.8 + 2.0 * aSeed.w) + aSeed.x * 30.0);
  vCol = mix(A, B, step(0.75, aSeed.w)) * (0.25 + 0.9 * aSeed.y * aSeed.y) * tw * uWeave * uGlow;
  gl_PointSize = (1.0 + 2.2 * aSeed.z * aSeed.z) * uPx * (17.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const MOTE_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = (1.0 - smoothstep(0.0, 0.5, length(c)));
  gl_FragColor = vec4(vCol * a * a, 1.0);
}
`;

/* ---------------- post ---------------- */

export const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uT;
uniform float uMotion;
uniform float uFloor;
uniform float uPx;
varying vec2 vUv;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 d = vUv - 0.5;
  // A whisper of lens fringe toward the corners.
  vec2 off = d * dot(d, d) * 0.006;
  vec3 c;
  c.r = texture2D(tDiffuse, vUv + off).r;
  c.g = texture2D(tDiffuse, vUv).g;
  c.b = texture2D(tDiffuse, vUv - off).b;
  float vig = (1.0 - smoothstep(0.25, 1.05, length(d * vec2(1.0, 1.15))));
  c *= mix(0.55, 1.0, vig);
  // Saturated, not blown out: pull the brightest values back toward their own hue.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.08);
  // The reply floats over the figure: below its top the figure steps back.
  float below = 1.0 - smoothstep(uFloor - 90.0 * uPx, uFloor, gl_FragCoord.y);
  c *= mix(1.0, 0.42, below * step(0.0, uFloor));
  float g = hash12(gl_FragCoord.xy + fract(uT * uMotion) * 113.0) - 0.5;
  c += g * 0.018;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;
