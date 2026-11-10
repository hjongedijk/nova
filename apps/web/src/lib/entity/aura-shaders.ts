import { PIECES, SDF_GLSL, WEAVE_REACH } from "./aura-body.ts";

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

const ARM = PIECES.arm[1]!.s as { a: readonly number[]; b: readonly number[] };
const ARM_A = `vec3(${ARM.a.map(f).join(", ")})`;
const ARM_B = `vec3(${ARM.b.map(f).join(", ")})`;

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
  const float e = 0.0012;
  return normalize(k.xyy * mapD(p + k.xyy * e) + k.yyx * mapD(p + k.yyx * e) +
                   k.yxy * mapD(p + k.yxy * e) + k.xxx * mapD(p + k.xxx * e));
}

/* The arms keep a quiet field of lines along their length, under the drawn curves. */
float psiArm(vec3 q) {
  float h = clamp((q.y - ${ARM_A}.y) / (${ARM_B}.y - ${ARM_A}.y), 0.0, 1.0);
  vec3 axis = mix(${ARM_A}, ${ARM_B}, h);
  float th = atan(q.z - axis.z, q.x - axis.x);
  return th * 5.0 / 6.2831853 + 0.35 * q.y;
}
/* One family's contribution: colour of its lines at this point. */
vec3 strokes(float psi, vec3 grad, vec3 n, float freq, float foot, float fam, vec3 p, vec3 A, vec3 B, float along, float detail) {
  float u = psi * freq;
  vec3 gt = grad - n * dot(n, grad);
  float fw = max(length(gt) * freq * foot, 1e-4);
  float d = abs(fract(u + 0.5) - 0.5) / fw;
  float idx = floor(u + 0.5);
  float h = hash11(idx * 7.13 + fam * 31.7);
  float core = clamp(1.0 - d / (0.9 + 1.4 * h * h), 0.0, 1.0);
  float halo = exp(-d * 0.22) * 0.28;
  // Lines closer than a few pixels fade instead of aliasing into grey.
  float resolve = 1.0 - smoothstep(0.12, 0.35, fw);
  // Each line is a stroke of its own length: it swells in and fades out along its way.
  float seg = vnoise3(p * vec3(1.7, 2.2, 1.7) + vec3(idx * 1.37 + fam * 5.1));
  float keep = smoothstep(0.3, 0.68, seg) * (0.55 + 0.45 * step(0.35, h));
  float travel = pow(0.5 + 0.5 * sin(along * 5.0 - uT * uPulse * uMotion * 1.6 + h * 40.0), 14.0);
  vec3 c = mix(A, B, step(0.84, h) * 0.85 + 0.1 * smoothstep(0.5, 1.0, seg));
  float bright = (0.2 + 1.3 * h * h * h) * keep * (1.0 + 1.1 * travel);
  return c * (core * 1.9 + halo) * bright * resolve * detail;
}

/* Distance to a quadratic Bezier in the plane, and the curve parameter of the closest point. */
vec2 sdBez(vec2 pos, vec2 A, vec2 B, vec2 C) {
  vec2 a = B - A;
  vec2 b = A - 2.0 * B + C;
  vec2 c = a * 2.0;
  vec2 d = A - pos;
  float kk = 1.0 / dot(b, b);
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float pp = ky - kx * kx;
  float qq = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = qq * qq + 4.0 * pp * pp * pp;
  float res;
  float tt;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - qq) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    tt = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    vec2 r = d + (c + b * tt) * tt;
    res = dot(r, r);
  } else {
    float z = sqrt(-pp);
    float v = acos(qq / (pp * z * 2.0)) / 3.0;
    float m = cos(v);
    float n = sin(v) * 1.732050808;
    vec3 t3 = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
    vec2 rx = d + (c + b * t3.x) * t3.x;
    vec2 ry = d + (c + b * t3.y) * t3.y;
    float dx = dot(rx, rx);
    float dy = dot(ry, ry);
    if (dx < dy) { res = dx; tt = t3.x; } else { res = dy; tt = t3.y; }
  }
  return vec2(sqrt(res), tt);
}

/*
 * One drawn line on the body, as a small bundle of strands (a bright core and two fainter companions), like
 * light caught in folds of silk. Widths are in screen pixels (foot = world size of a pixel); the ends taper.
 */
vec3 silk(vec2 xy, vec2 A, vec2 B, vec2 C, float foot, float bright, float warm, float id, vec3 cA, vec3 cB) {
  vec2 dt = sdBez(xy, A, B, C);
  float dpx = dt.x / foot;
  float tt = dt.y;
  float ends = smoothstep(0.0, 0.16, tt) * (1.0 - smoothstep(0.84, 1.0, tt));
  float core = clamp(1.0 - dpx / 1.4, 0.0, 1.0);
  float o1 = clamp(1.0 - abs(dt.x - 0.022) / foot / 0.9, 0.0, 1.0);
  float o2 = clamp(1.0 - abs(dt.x - 0.045) / foot / 0.8, 0.0, 1.0);
  float glow = exp(-dpx * 0.16) * 0.22;
  float shimmer = 0.75 + 0.25 * sin(tt * 9.0 + id * 4.0 + uT * uMotion * 0.4);
  float travel = pow(0.5 + 0.5 * sin(tt * 6.0 - uT * uPulse * uMotion * 1.4 + id * 2.3), 16.0);
  vec3 c = mix(cA, cB, warm * (0.6 + 0.4 * tt));
  return c * (core * 2.2 + o1 * 0.55 + o2 * 0.28 + glow) * bright * ends * shimmer * (1.0 + 1.2 * travel);
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
    if (d < 0.001) { hit = true; break; }
    if (d < dmin) { dmin = d; tmin = t; }
    t += d * 0.9;
    p = vWorld + rd * t;
    if (t > 2.2) break;
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
  float lineOn = 1.0 - smoothstep(front - 0.3, front + 0.04, dH);
  float fillOn = 1.0 - smoothstep(front - 0.85, front - 0.2, dH);
  // One-sided: sharp ahead of the front (no ghost of the unwoven body), a short trail behind it.
  float weaveEdge = exp(-max(dH - front, 0.0) * 40.0 - max(front - dH, 0.0) * 18.0) * (1.0 - uWeave) * smoothstep(0.0, 0.04, uWeave);
  float bottom = smoothstep(-3.05, -2.35, p.y);

  /* which part of the body: soft weights */
  vec4 wpart = exp(-max(parts, 0.0) * 28.0);
  wpart /= max(1e-4, wpart.x + wpart.y + wpart.z + wpart.w);

  vec3 q = vec3(abs(p.x), p.y, p.z);
  vec3 qh = ph;
  float warp = (vnoise3(p * 2.0 + vec3(0.0, 0.0, uT * 0.05 * uMotion)) - 0.5) * 0.05;
  vec3 lines = vec3(0.0);
  const float E = 0.003;
  vec2 xy = q.xy + vec2(warp * 0.4, 0.0);
  float fxy = foot / (0.35 + 0.65 * ndv);
  // A drawn composition, mirrored: collarbones up over the shoulders and down the arms, a sweep across the upper
  // chest to the underarm, the flank into the waist and out to the hips, and quieter lines under the bust and
  // over the ribs. Light gathers where they meet, at the heart.
  vec3 body = vec3(0.0);
  body += silk(xy, vec2(0.06, -0.5), vec2(0.43, -0.57), vec2(0.78, -0.47), fxy, 1.0, 0.8, 1.0, A, B);
  body += silk(xy, vec2(0.78, -0.47), vec2(0.92, -0.6), vec2(0.96, -1.3), fxy, 0.85, 0.35, 2.0, A, B);
  body += silk(xy, vec2(0.03, -0.63), vec2(0.36, -0.6), vec2(0.63, -0.84), fxy, 0.95, 0.15, 3.0, A, B);
  body += silk(xy, vec2(0.62, -0.84), vec2(0.44, -1.5), vec2(0.35, -2.0), fxy, 0.9, 0.0, 4.0, A, B);
  body += silk(xy, vec2(0.35, -2.0), vec2(0.33, -2.38), vec2(0.58, -2.78), fxy, 0.6, 0.0, 5.0, A, B);
  body += silk(xy, vec2(0.06, -1.47), vec2(0.3, -1.56), vec2(0.42, -1.86), fxy, 0.4, 0.2, 8.0, A, B);
  body += silk(xy, vec2(0.16, -0.3), vec2(0.44, -0.37), vec2(0.76, -0.46), fxy, 0.55, 0.3, 11.0, A, B);
  body += silk(xy, vec2(0.66, -0.95), vec2(0.73, -1.5), vec2(0.8, -2.05), fxy, 0.5, 0.0, 12.0, A, B);
  body += silk(xy, vec2(0.155, 0.04), vec2(0.11, -0.22), vec2(0.035, -0.46), fxy, 0.32, 0.4, 13.0, A, B);
  lines += body * (1.0 - wpart.w);
  if (wpart.z > 0.01) {
    float psi = psiArm(q) + warp * 2.0;
    vec3 g = GRAD(psiArm, q, E);
    g.x *= sign(p.x + 1e-5);
    lines += wpart.z * strokes(psi, g, n, 1.0, foot, 5.0, p, A, B, p.y, 0.35);
  }

  /* skin: nearly black inside, glossy violet in the light, bright at the silhouette */
  vec3 L = normalize(uKey);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, normalize(L + v)), 0.0), mix(70.0, 32.0, wpart.w)) * (1.0 - 0.2 * wpart.w);
  vec3 base = vec3(0.004, 0.0015, 0.011) + A * (0.003 + mix(0.03, 0.05, wpart.w) * diff * diff) + R * spec * mix(0.2, 0.3, wpart.w);
  base += A * pow(fres, 3.0) * 0.06;
  // Wide enough to cover a few pixels at the silhouette: a sub-pixel rim would flicker into dashes along
  // slanted edges (the stair steps of the pixel grid).
  vec3 rim = R * (pow(fres, 2.2) * 0.14 * (1.0 - 0.6 * wpart.w) + pow(fres, 4.0) * 0.8) + vec3(1.0, 0.93, 1.0) * pow(fres, 5.0) * 0.35;

  /* the face light: a soft glow on the forehead and the cheekbones, brightest in front */
  vec3 dfc = (qh - vec3(0.0, 0.5, 0.34)) * vec3(1.0, 0.7, 1.0);
  float faceLight = 0.2 * exp(-dot(dfc, dfc) / 0.06) * smoothstep(0.0, 0.7, nh.z) * wpart.w;

  /* a warm glow where the strokes meet, at the heart */
  vec3 dh = p - HEART;
  float heart = exp(-dot(dh, dh) / 0.008) * 0.12;

  /* starry interior: points just under the skin, with parallax */
  vec3 stars = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 35.0 : 56.0;
    vec3 pp = (p - n * (0.015 + 0.04 * float(k))) * sc;
    vec3 c = floor(pp);
    vec3 hh = hash33(c + float(k) * 19.0);
    float on = step(0.62, hh.x) * (k == 0 ? 1.0 : 0.7);
    float d = length(fract(pp) - (0.2 + 0.6 * hh));
    float tw = 0.55 + 0.45 * sin(uT * uMotion * (1.2 + 3.0 * hh.y) + hh.z * 6.2831);
    stars += on * (1.0 - smoothstep(0.0, 0.13, d)) * tw * mix(A, vec3(1.0, 0.82, 0.92), hh.y);
  }
  float starDensity = 0.35 + 0.65 * smoothstep(0.25, 0.7, vnoise3(p * 2.2 + 3.0)) * smoothstep(0.12, 0.4, ndv);

  float glow = uGlow * (1.0 + 0.45 * uAudio);
  // Lines bunch up where the skin turns away: let the rim own the silhouette. The waist stays quieter than the chest.
  lines *= smoothstep(0.06, 0.3, ndv) * (0.45 + 0.55 * smoothstep(-2.8, -1.8, p.y));
  vec3 lit = lines * glow * (1.0 + ring * 1.5);
  vec3 col = (base + rim * glow + F * faceLight * 0.9 * glow + (A + B) * 0.5 * heart * glow + stars * starDensity * 3.0) * fillOn;
  col += R * ring * pow(fres, 1.5) * 1.2 * fillOn;
  col += lit * lineOn;
  col += (A + B) * weaveEdge * 0.55;
  float alpha = fillOn * bottom * cover;
  col *= bottom * cover;

  vec4 clip = uPV * viewMatrix * vec4(p, 1.0);
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
  // Every strand has its own length; its lock narrows toward the end (tapered tips, not a cut fringe).
  float smax = 0.68 + 0.32 * hash11(seed * 17.3 + 4.1);
  float taper = 1.0 - 0.6 * smoothstep(0.55, 1.0, s / smax);
  pos += h3 * vec3(0.04, 0.012, 0.04) * (0.2 + 0.9 * s) * taper;
  pos += vec3(sin(s * 7.0 + seed * 21.0), 0.0, cos(s * 5.0 + seed * 13.0)) * 0.01 * s;
  float sw = s * s * uMotion;
  pos.x += sw * (0.04 * sin(uT * 0.55 + seed * 2.0 + pos.y * 1.4) + 0.012 * sin(uT * 1.35 + seed * 17.0));
  pos.z += sw * 0.025 * sin(uT * 0.42 + seed * 3.0 + pos.y);
  pos.y += uBreath * 0.008 * smoothstep(0.3, 0.8, s);
  float hw = 1.0 - 0.5 * smoothstep(0.3, 0.95, s);
  pos = mix(pos, uHead * (pos - PIVOT) + PIVOT, hw);

  float wk = waveK(pos);
  vec3 H = mix(uH0, uH1, wk);
  vec3 B = mix(uB0, uB1, wk);
  vec3 A = mix(uA0, uA1, wk);
  float hs = hash11(seed * 311.0);
  vec3 c = hs > 0.9 ? B : (hs > 0.55 ? A : H);
  // Light gathers along the length of the hair, not at the roots: no hot spot on the crown.
  float sheen = 0.55 + 0.45 * smoothstep(0.08, 0.45, s);
  float glint = 0.65 + 0.35 * sin(s * 16.0 - uT * uMotion * 0.6 * uPulse + seed * 50.0);
  float rev = (uWeave - 0.3) / 0.62 * 1.4 - seed * 0.3;
  float shown = 1.0 - smoothstep(rev - 0.06, rev, s);
  float ends = 1.0 - smoothstep(smax - 0.14, smax, s);
  float roots = smoothstep(0.0, 0.025, s);
  vCol = c * sheen * (0.4 + 0.9 * hs * hs) * glint * uGlow * (1.0 + 0.35 * uAudio) * (1.0 + waveRing(pos));
  vA = (0.036 + 0.04 * hs + 0.15 * step(0.94, hs)) * roots * ends * shown;
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
  gl_PointSize = (1.0 + 2.2 * aSeed.z * aSeed.z) * uPx * (14.0 / -mv.z);
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
