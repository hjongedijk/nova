/**
 * GESTALTE v6 shaders. GLSL ES 3.00 through three.js ShaderMaterial (attribute/varying/gl_FragColor are mapped).
 * Everything is procedural: a point cloud strung along contour bands of the body, a neon fresnel rim, a warm
 * fire in the face with amber veins, a dotted mountain land with lava veins and slow living lights.
 *
 * Mood changes never move a point: two looks (A outside, B inside) and a radius that grows from the face.
 * The birth is a river of points out of the orb, a face that ignites, and one shockwave ring.
 */

/** Hash and gradient noise, written for this file. */
export const NOISE = /* glsl */ `
float g_h11(float n) { return fract(sin(n * 91.3458 + 17.17) * 47453.5453); }
vec3 g_h33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float g_noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(g_h33(i), f);
  float n100 = dot(g_h33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(g_h33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(g_h33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(g_h33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(g_h33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(g_h33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(g_h33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}
`;

/** Head and torso transforms, blended along the neck by the head weight. */
const POSE = /* glsl */ `
uniform mat3 uHead;
uniform mat3 uTorso;
uniform vec3 uPivot;
uniform vec3 uPivotT;
vec3 posePoint(vec3 p, float hw) {
  vec3 ph = uHead * (p - uPivot) + uPivotT;
  vec3 pt = uTorso * p;
  return mix(pt, ph, hw);
}
vec3 poseNormal(vec3 n, float hw) {
  return normalize(mix(uTorso * n, uHead * n, hw));
}
`;

/** Breathing, anchored low: the chest rises and swells, the head rides on it a little. Shared by every layer. */
const BREATH = /* glsl */ `
uniform float uBreath;
vec3 breathe(vec3 p, vec3 n, float hw) {
  float chest = (1.0 - hw) * smoothstep(-3.0, -1.5, p.y);
  p.y += uBreath * (0.011 * chest + 0.007 * hw);
  p += n * uBreath * 0.009 * chest * smoothstep(-0.1, 0.4, n.z) * smoothstep(-1.3, -1.9, p.y);
  return p;
}
`;

/* Keep the reply and the composer readable: the figure steps back below the reply's top and near the bottom. */
const FLOOR = /* glsl */ `
uniform float uFloor;
uniform float uH;
uniform float uPx;
float floorFade() {
  float fy = gl_FragCoord.y;
  float f = mix(0.38, 1.0, smoothstep(uFloor - 140.0 * uPx, uFloor + 20.0 * uPx, fy));
  return f * mix(0.42, 1.0, smoothstep(0.02 * uH, 0.24 * uH, fy));
}
`;

/** The body mesh: a dark fill (depth for the points, blocks the land) or the soft neon shell outside it. */
export const MESH_VERT = /* glsl */ `
${POSE}
${BREATH}
attribute float aHead;
uniform float uShell;
varying vec3 vN;
varying vec3 vView;
void main() {
  vec3 p = breathe(position, normal, aHead);
  vec3 bp = posePoint(p, aHead);
  vec3 bn = poseNormal(normal, aHead);
  bp += bn * uShell;
  vec4 mv = viewMatrix * vec4(bp, 1.0);
  vView = mv.xyz;
  vN = normalize(mat3(viewMatrix) * bn);
  gl_Position = projectionMatrix * mv;
}
`;

export const FILL_FRAG = /* glsl */ `
uniform vec3 uVoid;
void main() { gl_FragColor = vec4(uVoid, 1.0); }
`;

export const SHELL_FRAG = /* glsl */ `
${FLOOR}
uniform vec3 uRimMix;
uniform float uDim;
uniform float uShellA;
varying vec3 vN;
varying vec3 vView;
void main() {
  float fres = 1.0 - clamp(abs(dot(normalize(vN), normalize(-vView))), 0.0, 1.0);
  float g = pow(fres, 3.2);
  gl_FragColor = vec4(uRimMix * g * 0.2 * uShellA * uDim * floorFade(), 1.0);
}
`;

/** The figure: every dot of every band, the dust between them and the veins. */
export const FIG_VERT = /* glsl */ `
${NOISE}
${POSE}
${BREATH}
attribute vec4 aData;
attribute vec4 aExtra;
uniform float uT;
uniform float uMotion;
uniform float uAudio;
uniform float uDim;
uniform float uPx;
uniform float uH;
uniform float uSize;
uniform float uComp;
uniform float uAsm;
uniform vec3 uSrc;
uniform float uSrcR;
uniform float uIgnite;
uniform float uShockR;
uniform float uShockA;
uniform float uMoodR;
uniform float uMoodEdge;
uniform float uYaw;
uniform float uScan;
uniform vec3 uRimA;
uniform vec3 uRimB;
uniform vec3 uLineA;
uniform vec3 uLineB;
uniform vec3 uCore;
uniform vec3 uHot;
uniform vec4 uLookA;
uniform vec4 uLookB;
uniform vec4 uStyleA;
uniform vec4 uStyleB;
varying vec3 vCol;
void main() {
  float hw = aData.x;
  float kind = aData.y;
  float seed = aData.z;
  float ord = aData.w;
  float t = uT * uMotion;
  // Light patterns keep a slow pulse under reduced motion; positions do not move.
  float tl = uT * mix(0.25, 1.0, uMotion);
  vec3 r = position;
  float isBand = 1.0 - step(0.5, kind);
  float isVein = step(0.5, kind) * (1.0 - step(1.5, kind));

  // The face's bands ripple slowly, a few waves across it.
  float face = smoothstep(0.3, 0.55, r.z) * smoothstep(-0.98, -0.6, r.y) * (1.0 - smoothstep(0.32, 0.56, abs(r.x)));
  vec3 p = r;
  p.y += face * isBand * (0.0065 * sin(r.x * 17.0 + t * 0.6 + r.y * 2.6) + 0.003 * sin(r.x * 8.5 - t * 0.42 - r.y * 3.4));
  p = breathe(p, normal, hw);
  vec3 bp = posePoint(p, hw);
  vec3 bn = poseNormal(normal, hw);

  // Mood: inside the radius from the face the new look, outside the old one, a soft glowing seam between.
  float d = length(r - vec3(0.0, -0.2, 0.3));
  float inside = smoothstep(uMoodR + 0.1, uMoodR - 0.1, d);
  float seam = exp(-pow((d - uMoodR) / 0.1, 2.0)) * uMoodEdge;
  vec3 rimC = mix(uRimA, uRimB, inside);
  vec3 lineC = mix(uLineA, uLineB, inside);
  vec4 look = mix(uLookA, uLookB, inside);
  vec4 sty = mix(uStyleA, uStyleB, inside);

  // The birth shockwave: a ring of light out of the face that lifts the dots it passes, then lets them go.
  float ring = exp(-pow((d - uShockR) / 0.24, 2.0)) * uShockA;
  bp += bn * ring * 0.03;

  // Birth: each dot leaves the orb in turn (bottom of the body first, the dome of the head last) and flows
  // along one shared bend, a river, into its place. At e = 1 it is exactly at rest.
  float e = clamp((uAsm - ord * 1.1 - seed * 0.2) / 0.7, 0.0, 1.0);
  float u = 1.0 - pow(1.0 - e, 4.0);
  vec3 wp = bp;
  if (e < 1.0) {
    vec3 rnd = vec3(g_h11(seed * 13.1), g_h11(seed * 7.3 + 2.0), g_h11(seed * 3.7 + 5.0)) - 0.5;
    vec3 src = uSrc + rnd * uSrcR * 1.4;
    vec3 ctrl = mix(src, bp, 0.5) + vec3(-1.5 + rnd.x * 0.7, -1.0 + rnd.y * 0.5, 1.1 + rnd.z * 0.4);
    float iu = 1.0 - u;
    wp = iu * iu * src + 2.0 * iu * u * ctrl + u * u * bp;
    wp += vec3(sin(u * 9.0 + seed * 20.0), cos(u * 7.0 + seed * 13.0), 0.0) * iu * u * 0.22;
  }

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vec3 V = normalize(cameraPosition - wp);
  float fres = 1.0 - clamp(abs(dot(bn, V)), 0.0, 1.0);
  float near = smoothstep(-0.5, 0.6, wp.z);
  // Relief inside the face (sockets, under the brow) turns away too, but it is shade, not edge.
  float top = 1.0 - 0.45 * smoothstep(0.7, 0.98, normal.y);
  float rimK = pow(fres, 3.6) * (1.0 - 0.9 * face) * top;
  float sil = pow(fres, 9.0) * (1.0 - face) * top;
  // Head turn: the side turning away darkens, the silhouette it leaves gets brighter.
  float turn = min(1.0, abs(uYaw) / 0.25);
  float away = hw * smoothstep(0.0, 0.45, r.x * sign(uYaw)) * turn;

  float bandH = aExtra.z;
  float az = atan(r.x, r.z + 0.25);
  float dir = bandH > 0.5 ? 1.0 : -1.0;
  float glint = pow(0.5 + 0.5 * sin(az * 26.0 + bandH * 60.0 + t * (0.4 + bandH) * dir), 30.0);
  float bandVar = 0.7 + 0.6 * g_h11(bandH * 31.0);

  // Interior dim and deep, the silhouette a saturated neon (never white: the rim colour carries little red).
  vec3 col = lineC * (0.17 + 0.12 * near + 0.07 * hw) * bandVar * (1.0 - 0.6 * rimK)
           + rimC * (rimK * 1.0 * look.z + sil * 0.9 * (1.0 + 0.9 * turn));
  col *= 1.0 - 0.6 * away * (1.0 - sil);
  // Hollows in the face read as shade: where its bands crowd at a grazing angle they dim instead of piling up.
  col *= 1.0 - 0.7 * face * smoothstep(0.25, 0.75, fres);
  col += rimC * glint * 0.5 * isBand * (0.35 + 0.65 * near);

  // Fire in the face: a broad soft field over the mid-face, stirred so hot spots flow through it.
  vec2 dc = vec2(r.x / 0.46, (r.y + 0.2) / 0.36);
  float turb = g_noise(vec3(r.x * 3.2, r.y * 3.2 - tl * 0.35, tl * 0.18 + 4.0))
             + 0.5 * g_noise(vec3(r.x * 7.0 + 2.0, r.y * 7.0 + tl * 0.5, tl * 0.3));
  float core = exp(-dot(dc, dc) * 1.25) * smoothstep(0.05, 0.4, r.z) * (0.7 + 0.5 * turb) * look.y * uIgnite;
  // Speaking: brightness follows the voice, spreading from the mouth in rings.
  vec3 dm3 = (r - vec3(0.0, -0.5, 0.55)) * vec3(1.0, 1.35, 1.0);
  float dm = length(dm3);
  float voice = look.w * uAudio;
  core *= 1.0 + 0.8 * voice;
  float coreMix = smoothstep(0.05, 0.55, core);
  vec3 amber = mix(uCore, uHot, smoothstep(0.5, 1.3, core));
  col = mix(col, amber * (0.38 + 1.0 * core) * (1.0 - 0.75 * face * smoothstep(0.25, 0.75, fres)), coreMix * (1.0 - step(1.5, kind) * 0.5) * (1.0 - sil));
  col += amber * core * 0.06;

  // Veins: amber strands with slow pulses running down them, flickering like a discharge.
  if (isVein > 0.5) {
    float s = aExtra.x;
    float str = aExtra.y;
    float pulse = 0.5 + 0.5 * sin(s * 20.0 - tl * 2.4 + aExtra.z * 1.7);
    float flick = 0.75 + 0.25 * g_noise(vec3(s * 6.0 - tl * 1.3, seed * 4.0, tl * 0.4));
    col = mix(uCore, uHot, 0.5 * str) * str * (0.6 + 0.7 * pulse) * flick * look.y * (0.9 + 0.5 * voice) * 1.3;
    col *= uIgnite * smoothstep(-2.5, -2.0, r.y);
  }
  col *= kind > 1.5 ? 0.42 : 1.0;

  // State styles: an idle scan, rising bands while thinking, a fast sweep while executing, an attentive head
  // while listening, the voice while speaking.
  float g = look.x;
  float scan = exp(-pow((r.y - uScan) * 4.5, 2.0));
  g *= 1.0 + scan * (0.3 * sty.w + 1.1 * sty.z)
           + sty.x * 0.9 * pow(max(0.0, sin(r.y * 6.0 - tl * 2.2)), 10.0)
           + sty.y * (0.3 + 0.15 * sin(tl * 2.2)) * hw
           + voice * (0.35 * hw + 0.9 * exp(-dm * 1.6) * (0.6 + 0.4 * sin(dm * 24.0 - tl * 8.0)));
  col *= g;
  col += rimC * (seam * 0.9 + ring * 2.4);

  // Dots in flight are a stream of the rim's colour, settling into their own as they land.
  float flying = step(e, 0.999);
  col = mix(col, rimC * 0.7, flying * (1.0 - u) * 0.8);

  float projPx = projectionMatrix[1][1] * 0.5 * uH / max(0.1, -mv.z);
  float sz = uSize * projPx * uComp * (kind > 1.5 ? 0.85 : 1.0 + 0.6 * isVein) * (1.0 + 0.8 * ring + 0.6 * flying * (1.0 - u));
  float a = 1.0;
  if (sz < 1.0) { a = sz; sz = 1.0; }
  gl_PointSize = sz;
  vCol = col * a * uDim * smoothstep(0.0, 0.06, e);
  gl_Position = projectionMatrix * mv;
}
`;

export const POINT_FRAG = /* glsl */ `
${FLOOR}
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d);
  gl_FragColor = vec4(vCol * a * floorFade(), 1.0);
}
`;

/** Dust shed from the silhouette: drifting off the crown like hair of light and off the shoulders. */
export const SPARK_VERT = /* glsl */ `
${NOISE}
${POSE}
attribute float aHead;
attribute vec4 aSeed;
uniform float uT;
uniform float uMotion;
uniform float uPx;
uniform float uReady;
uniform float uAudio;
varying float vA;
varying float vWarm;
varying float vLife;
void main() {
  float tt = uT * uMotion;
  float life = fract(tt * mix(0.04, 0.14, aSeed.y) + aSeed.x);
  vec3 p = posePoint(position, aHead);
  vec3 n = poseNormal(normal, aHead);
  float crown = smoothstep(0.25, 0.9, n.y) * aHead;
  // Out along the normal and up, then carried by the curl of a slow noise field (divergence-free: it curls
  // like smoke instead of jittering).
  vec3 base = p + n * (0.01 + 0.28 * life + 0.1 * uAudio * life)
            + vec3((0.2 * n.x + 0.6 * (aSeed.y - 0.5) * crown) * life, (0.42 * crown + 0.1) * life, 0.0);
  vec3 sp = base * 1.4 + vec3(aSeed.z * 3.0, -tt * 0.12, tt * 0.05);
  const float e = 0.09;
  float dy = g_noise(sp + vec3(0.0, e, 0.0)) - g_noise(sp - vec3(0.0, e, 0.0));
  float dx = g_noise(sp + vec3(e, 0.0, 0.0)) - g_noise(sp - vec3(e, 0.0, 0.0));
  vec2 curl = vec2(dy, -dx) / (2.0 * e);
  vec3 wp = base + vec3(curl * 0.1 * life * (0.5 + crown), 0.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float near = smoothstep(-0.05, 0.25, n.z + 0.3);
  vWarm = step(0.95, aSeed.z);
  vLife = life;
  vA = pow(1.0 - life, 1.4) * smoothstep(0.0, 0.05, life) * uReady * (0.3 + 0.7 * aSeed.w) * near
     * (1.0 - 0.7 * smoothstep(0.92, 1.0, n.y));
  gl_PointSize = max(1.0, (1.1 + 2.0 * aSeed.z * aSeed.z * aSeed.z) * uPx * (1.0 - 0.3 * life));
  gl_Position = projectionMatrix * mv;
}
`;

export const SPARK_FRAG = /* glsl */ `
uniform vec3 uRimMix;
uniform vec3 uCore;
uniform float uDim;
varying float vA;
varying float vWarm;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  // Brightest leaving the surface, cooling into the rim's colour; a few warm embers among them.
  vec3 c = mix(uRimMix * 1.35, uRimMix * 0.8, smoothstep(0.0, 0.5, vLife));
  c = mix(c, uCore * 1.3, vWarm);
  gl_FragColor = vec4(c * a * vA * uDim * 2.6, 1.0);
}
`;

/** The soft warm light behind the face's lines: a camera-facing quad, kept low so it never reads as a blob. */
export const CORE_VERT = /* glsl */ `
uniform vec3 uCoreC;
uniform float uCoreS;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = viewMatrix * vec4(uCoreC, 1.0);
  mv.xy += position.xy * uCoreS;
  gl_Position = projectionMatrix * mv;
}
`;

export const CORE_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHot;
uniform float uCoreI;
uniform float uDim;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.y *= 1.25;
  float d2 = dot(p, p);
  float g = exp(-d2 * 3.2) * 0.12 + exp(-d2 * 9.0) * 0.08;
  g *= 1.0 - smoothstep(0.55, 0.98, length(p));
  vec3 c = mix(uCore, uHot, 0.3 * exp(-d2 * 6.0));
  gl_FragColor = vec4(c * g * uCoreI * uDim, 1.0);
}
`;

/** Full-screen sky: near black, a faint cool light behind the head, sparse stars. */
export const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0);
}
`;

export const BG_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uVoid;
uniform vec3 uBg;
uniform vec3 uRimMix;
uniform vec3 uHaze;
uniform vec2 uPar;
uniform float uT;
uniform float uMotion;
uniform float uPx;
uniform float uFade;
varying vec2 vUv;
float b_h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float b_n(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(b_h21(i), b_h21(i + vec2(1.0, 0.0)), f.x), mix(b_h21(i + vec2(0.0, 1.0)), b_h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float stars(vec2 px, float cell, float seed, float density, float t) {
  vec2 g = floor(px / cell);
  vec2 f = fract(px / cell);
  float h = b_h21(g + seed);
  if (h < density) return 0.0;
  vec2 c = 0.2 + 0.6 * vec2(b_h21(g + seed + 3.1), b_h21(g + seed + 7.7));
  float d = length((f - c) * cell) / uPx;
  float tw = 0.6 + 0.4 * sin(t * (0.5 + 1.5 * b_h21(g + 1.3)) + h * 40.0);
  float big = pow(b_h21(g + 9.4), 6.0);
  return exp(-d * d / (0.3 + 1.2 * big)) * tw * (0.3 + 1.2 * big);
}
void main() {
  float asp = uRes.x / uRes.y;
  float t = uT * uMotion;
  vec2 p = (vUv - vec2(0.5, 0.66)) * vec2(asp, 1.0);
  float r = length(p * vec2(0.8, 1.0));
  vec3 c = mix(uBg * 0.12, uVoid, smoothstep(0.0, 0.7, r));
  c += uRimMix * 0.012 * exp(-r * r * 5.0);
  // Faint slow mist, barely there: depth without lifting the black.
  vec2 np = p * 1.3 + uPar * 0.04 + vec2(t * 0.004, -t * 0.002);
  float neb = b_n(np * 2.0) * b_n(np * 3.7 + 4.0);
  c += uHaze * 0.018 * neb * smoothstep(0.35, 0.8, vUv.y);
  float side = smoothstep(0.16, 0.32, abs(vUv.x - 0.5)) + smoothstep(0.85, 0.98, vUv.y);
  vec2 px = gl_FragCoord.xy;
  float st = stars(px + uPar * 6.0 * uPx, 9.0 * uPx, 0.0, 0.94, t) * 0.45
           + stars(px + uPar * 26.0 * uPx, 29.0 * uPx, 11.0, 0.95, t);
  c += mix(uHaze, vec3(1.0), 0.3) * st * clamp(side, 0.0, 1.0) * smoothstep(0.4, 0.75, vUv.y) * 0.4 * uFade;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** The land: dotted ranges with lava veins and a few lights that slowly wake and fade. */
export const LAND_VERT = /* glsl */ `
attribute vec4 aLand;
uniform float uT;
uniform float uMotion;
uniform float uPx;
uniform float uH;
uniform float uComp;
uniform float uShockR;
uniform float uShockA;
uniform float uLandOn;
uniform float uFade;
uniform vec2 uPar;
uniform vec3 uGrid;
uniform vec3 uHaze;
uniform vec3 uStreak;
uniform vec3 uRimMix;
varying vec3 vCol;
void main() {
  vec3 w = position;
  float D = 8.5 - w.z;
  // Parallax with the gaze: the near ranges slide against the far ones.
  float par = 10.0 / D;
  w.x -= uPar.x * 0.55 * par;
  w.y += uPar.y * 0.12 * par;
  float t = uT * uMotion;
  float tl = uT * mix(0.2, 1.0, uMotion);
  float light = aLand.x;
  float lava = aLand.y;
  float seed = aLand.z;
  float kind = aLand.w;
  // The birth shockwave reveals the land as it passes and lights it up for a moment.
  float dist = length(w.xz - vec2(0.0, 0.3));
  float reveal = max(uLandOn, smoothstep(uShockR + 0.5, uShockR - 5.0, dist));
  float ring = exp(-pow((dist - uShockR) / (0.8 + 0.1 * uShockR), 2.0)) * uShockA;
  float air = smoothstep(12.0, 70.0, D);
  vec3 cy = mix(uGrid, uHaze, air * 0.75);
  vec3 col = cy * (0.05 + 2.3 * light * light * light + 0.06 * seed);
  float lf = 0.6 + 0.4 * sin(tl * (0.4 + 0.8 * seed) + seed * 40.0);
  col += uStreak * lava * 4.0 * lf;
  float sz = clamp(26.0 / D, 0.6, 2.6) * uPx * uComp * (0.8 + 0.4 * light + 0.6 * lava);
  if (kind > 0.5) {
    float per = 16.0 + 18.0 * seed;
    float c = fract(t / per + seed * 7.0);
    float wake = smoothstep(0.0, 0.12, c) * (1.0 - smoothstep(0.28, 0.5, c));
    vec3 lc = seed > 0.6 ? uStreak * 1.3 : mix(uGrid, vec3(0.75, 0.95, 1.0), 0.5);
    col += lc * wake * 1.6;
    sz *= 1.0 + 1.2 * wake;
  }
  col += uRimMix * ring * (0.9 + 1.5 * light);
  col *= exp(-(D - 7.0) * 0.016) * smoothstep(5.0, 12.0, D) * reveal * uFade;
  float a = 1.0;
  if (sz < 1.0) { a = sz; sz = 1.0; }
  gl_PointSize = sz;
  vCol = col * a;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

export const LAND_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d);
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

/**
 * Final pass, in display space after tone mapping: a slight lens chromatic aberration toward the edges,
 * a gentle S-curve, a vignette that frames the figure, fine film grain. No glitches, no blinking.
 */
export const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uT;
uniform float uMotion;
uniform float uPx;
varying vec2 vUv;
float p_h(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d * vec2(uRes.x / uRes.y, 1.0), d * vec2(uRes.x / uRes.y, 1.0));
  vec2 off = d * r2 * 0.005;
  vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
  c = clamp(c, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.25);
  float vig = smoothstep(1.25, 0.35, length(d * vec2(1.0, 1.15)) * 1.6);
  c *= 0.5 + 0.5 * vig;
  float t = uT * uMotion;
  float gr = p_h(gl_FragCoord.xy + fract(t * 0.37) * 517.0) - 0.5;
  c += gr * 0.022 * (1.0 - 0.6 * l);
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

export const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
