/**
 * GESTALTE shaders. GLSL ES 3.00 through three.js ShaderMaterial (attribute/varying/gl_FragColor are mapped).
 * Everything is procedural: contour lines from a field over the body, dots along them, a fresnel rim, a warm
 * core, branching filaments from noise ridges, a perspective landscape of dots and grid lines.
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

export const BODY_VERT = /* glsl */ `
${POSE}
attribute vec3 aOrb;
attribute float aDelay;
attribute float aHead;
uniform float uForm;
uniform float uBreath;
uniform float uOpen;
uniform vec3 uOrbC;
uniform float uOrbR;
uniform float uShell;
varying vec3 vRest;
varying vec3 vN;
varying vec3 vView;
varying float vE;
varying float vHead;
void main() {
  float e = clamp((uForm - aDelay) / 0.58, 0.0, 1.0);
  e = e < 0.5 ? 4.0 * e * e * e : 1.0 - pow(-2.0 * e + 2.0, 3.0) / 2.0;
  vec3 p = position;
  // Breathing lifts the shoulders a touch more than the head.
  p.y += uBreath * (0.01 + 0.014 * (1.0 - aHead));
  vec3 bp = posePoint(p, aHead);
  vec3 bn = poseNormal(normal, aHead);
  bp += bn * uShell;
  vec3 op = uOrbC + aOrb * uOrbR;
  vec3 wp = mix(op, bp, e);
  vec3 wn = normalize(mix(aOrb, bn, e));
  vRest = position;
  vE = e;
  vHead = aHead;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vView = mv.xyz;
  vN = normalize(mat3(viewMatrix) * wn);
  gl_Position = projectionMatrix * mv;
}
`;

const LOOK = /* glsl */ `
uniform float uT;
uniform float uMotion;
uniform float uAudio;
uniform float uDim;
uniform float uPx;
uniform float uFloor;
uniform float uH;
uniform vec4 uW;
uniform float uScan;
uniform float uCoreI;
uniform vec3 uLine;
uniform vec3 uLine2;
uniform vec3 uRim;
uniform vec3 uCore;
uniform vec3 uHot;
/* Keep the reply and the composer readable: the figure steps back below the reply's top and near the bottom. */
float floorFade() {
  float fy = gl_FragCoord.y;
  float f = mix(0.38, 1.0, smoothstep(uFloor - 140.0 * uPx, uFloor + 20.0 * uPx, fy));
  return f * mix(0.42, 1.0, smoothstep(0.02 * uH, 0.24 * uH, fy));
}
`;

export const BODY_FRAG = /* glsl */ `
${NOISE}
${LOOK}
varying vec3 vRest;
varying vec3 vN;
varying vec3 vView;
varying float vE;
varying float vHead;

void main() {
  vec3 n = normalize(vN);
  vec3 vd = normalize(-vView);
  float ndv = dot(n, vd);
  float fres = 1.0 - clamp(abs(ndv), 0.0, 1.0);
  vec3 r = vRest;
  float hw = smoothstep(0.0, 1.0, vHead);
  float ax = abs(r.x);
  float t = uT * uMotion;
  float speak = uW.w * uAudio;

  // The warm core: a broad soft field over the mid-face (eye line to upper lip, ~60% of its width),
  // stirred by slow turbulence so hot spots flow through it.
  vec2 dc = vec2(r.x / 0.44, (r.y + 0.2) / 0.3);
  float turb = g_noise(vec3(r.x * 3.2, r.y * 3.2 - t * 0.35, t * 0.18 + 4.0))
             + 0.5 * g_noise(vec3(r.x * 7.0 + 2.0, r.y * 7.0 + t * 0.5, t * 0.3));
  float core = exp(-dot(dc, dc) * 1.1) * smoothstep(0.0, 0.35, r.z) * (0.75 + 0.45 * turb) * uCoreI;

  // Face: clearly wavy lines, four or so waves across the face, drifting; strongest over the core.
  float rip = sin(r.x * 17.0 + t * 0.6 + r.y * 2.6) * 0.42
            + sin(r.x * 8.5 - t * 0.42 - r.y * 3.4) * 0.16
            + sin(r.x * 29.0 + t * 1.1 + r.y * 7.0) * 0.05;
  rip *= 1.0 + 1.1 * core + speak * 1.6;
  vec3 dmv = (r - vec3(0.0, -0.5, 0.55)) * vec3(1.0, 1.35, 1.0);
  float dm = length(dmv);
  rip += speak * sin(dm * 24.0 - uT * 8.0) * 0.4 * exp(-dm * 1.1);
  float D = 31.0;
  float fFace = r.y * D + rip;
  // Neck, shoulders and chest: plane slices of the body, like the face but calm. The planes lean back a little
  // (the view is from a little above), so the lines bow down over the chest, wrap the deltoids and ring the neck
  // on top of the shoulders: the torso reads as a volume, not a flat plate. A faint slow drift keeps them alive.
  float flow = g_noise(vec3(r.x * 0.8, r.y * 0.8, t * 0.04 + 2.0));
  float fBody = (r.y + 0.2 * r.z) * D + rip * 0.1 + 0.4 * flow;
  float v = mix(fBody, fFace, hw);

  float fw = max(fwidth(v), 1e-4);
  float dPx = (0.5 - abs(fract(v) - 0.5)) / fw;
  float line = 1.0 - smoothstep(0.25, 1.1, dPx);
  // Where the lines crowd (grazing angles) they merge into a soft sheen instead of shimmering.
  float clear = smoothstep(0.6, 0.3, fw);

  // Dots of light along every line, drifting; neighbouring lines drift opposite ways.
  float li = floor(v + 0.5);
  float hs = g_h11(li);
  float u0 = mix(r.x, atan(r.x, r.z + 0.25) * 0.72, hw);
  float dir = hs > 0.5 ? 1.0 : -1.0;
  float uu = u0 * 96.0 + hs * 17.0 + t * (0.5 + 1.2 * g_h11(li * 1.7)) * dir * (1.0 + 2.5 * uW.z);
  float fu = max(fwidth(uu), 1e-4);
  float duPx = (0.5 - abs(fract(uu) - 0.5)) / fu;
  float dotm = 1.0 - smoothstep(0.5, 1.5, length(vec2(duPx, dPx)));
  float tw = 0.4 + 0.6 * g_h11(li * 7.31 + floor(uu) * 0.137);
  float lines = (line * 0.34 + dotm * tw * (1.0 + 0.45 * hw)) * clear + (1.0 - clear) * 0.22;

  // State: a slow scan while ready, rising bands while thinking, a fast sweep while executing,
  // an attentive head while listening, the voice spreading from the mouth while speaking.
  float idle = clamp(1.0 - uW.x - uW.y - uW.z - uW.w, 0.0, 1.0);
  float scan = exp(-pow((r.y - uScan) * 4.5, 2.0));
  float gain = 1.0 + scan * (0.45 * idle + 1.3 * uW.z);
  gain += uW.y * 1.1 * pow(max(0.0, sin(r.y * 6.0 - uT * 2.2)), 10.0);
  gain += uW.x * (0.3 + 0.2 * sin(uT * 2.2)) * hw;
  gain += speak * 0.9 * exp(-dm * 1.6);

  float coreMix = smoothstep(0.05, 0.5, core * (1.0 + 0.5 * speak));
  vec3 lc = mix(uLine, uLine2, 0.3 + 0.7 * fres);
  // Inside the warm field the lines turn amber and brighter, never white.
  lc = mix(lc, mix(uCore, uHot, smoothstep(0.5, 1.2, core)) * 1.25, coreMix);
  gain *= 1.0 + 0.9 * coreMix;
  vec3 col = lc * lines * gain * (0.55 + 0.7 * fres);
  col += uLine * 0.02;
  // The warm field glows behind the lines, not only through them.
  col += uCore * core * (0.16 + 0.1 * speak) + uHot * core * core * 0.05;

  // The rim: a thick, very bright edge around the whole silhouette.
  float rim = smoothstep(0.36, 0.95, fres);
  col += uRim * (rim * rim * 1.9 + pow(fres, 7.0) * 1.5);

  // Branching filaments from the jaw down the front of the neck, then fanning out from the sternal notch over
  // the collarbones and the chest, slowly flickering.
  vec2 nc = vec2(r.x, r.y + 1.52);
  float vm = smoothstep(-0.55, -0.8, r.y) * smoothstep(-2.5, -1.85, r.y)
           * (1.0 - smoothstep(0.65, 1.15, ax)) * smoothstep(-0.05, 0.2, r.z);
  if (vm > 0.002) {
    // Zero crossings of warped noise, drawn a pixel or two wide: thin trunks, finer branches off them.
    // Above the notch the noise is stretched down the neck; below it, along rays out of the notch.
    float below = smoothstep(-1.3, -1.65, r.y);
    float ang = atan(nc.x, -nc.y + 0.25);
    float rad = length(nc * vec2(1.0, 1.3));
    // Both run the same way and meet at the blend, so the hand-over never packs the noise into a band.
    vec2 q = mix(vec2(r.x * 6.2, r.y * 1.4), vec2(ang * 3.4, -2.05 - rad * 1.0), below);
    q.x += 0.55 * g_noise(vec3(r.x * 2.1, r.y * 2.4, 3.1));
    float a = g_noise(vec3(q, t * 0.03 + 1.0));
    float b = g_noise(vec3(q * 2.6 + 4.7, t * 0.045 + 7.0));
    float aw = abs(a) / max(fwidth(a), 1e-4);
    float bw = abs(b) / max(fwidth(b), 1e-4);
    float trunk = 1.0 - smoothstep(0.3, 1.2, aw);
    float branch = (1.0 - smoothstep(0.2, 0.9, bw)) * (1.0 - smoothstep(0.05, 0.2, abs(a)));
    float c3 = g_noise(vec3(q * vec2(1.7, 3.2) + 9.1, t * 0.06 + 3.0));
    float cw = abs(c3) / max(fwidth(c3), 1e-4);
    float twig = (1.0 - smoothstep(0.2, 0.8, cw)) * (1.0 - smoothstep(0.08, 0.3, abs(b)));
    float vein = trunk + (0.85 * branch + 0.55 * twig) * (1.0 - 0.55 * below);
    float flick = 0.55 + 0.45 * g_noise(vec3(r.y * 3.0 - t * 1.4, r.x * 2.0, t * 0.5));
    col += uHot * vein * vm * (1.0 - 0.25 * below) * (1.0 - 0.6 * rim) * (0.65 + 0.7 * flick) * (1.2 + speak * 0.8);
  }

  float alpha = smoothstep(0.0, 0.45, vE);
  gl_FragColor = vec4(col * alpha * uDim * floorFade(), 1.0);
}
`;

/** The outer shell: a fresnel-only skin just outside the body, so the rim's light reaches past the edge. */
export const SHELL_FRAG = /* glsl */ `
${LOOK}
varying vec3 vRest;
varying vec3 vN;
varying vec3 vView;
varying float vE;
varying float vHead;
void main() {
  vec3 n = normalize(vN);
  float fres = 1.0 - clamp(abs(dot(n, normalize(-vView))), 0.0, 1.0);
  float g = pow(fres, 3.0);
  float alpha = smoothstep(0.3, 0.9, vE);
  gl_FragColor = vec4(uRim * g * 0.5 * alpha * uDim * floorFade(), 1.0);
}
`;

/** Sparks: points shed from the silhouette, like hair of light from the crown. */
export const SPARK_VERT = /* glsl */ `
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
void main() {
  float life = fract(uT * uMotion * mix(0.05, 0.17, aSeed.y) + aSeed.x);
  vec3 p = posePoint(position, aHead);
  vec3 n = poseNormal(normal, aHead);
  float crown = smoothstep(0.25, 0.9, n.y) * aHead;
  vec3 drift = n * (0.012 + 0.22 * life + 0.1 * uAudio * life)
             + vec3(0.0, 0.5 * life * life * crown + 0.12 * life, 0.0)
             + 0.07 * life * vec3(sin(aSeed.z * 40.0 + uT * uMotion * 0.9), cos(aSeed.w * 30.0 + uT * uMotion * 0.7), 0.0);
  vec4 mv = viewMatrix * vec4(p + drift, 1.0);
  float near = smoothstep(-0.05, 0.25, n.z + 0.3);
  vA = pow(1.0 - life, 1.7) * smoothstep(0.0, 0.06, life) * uReady * (0.35 + 0.65 * aSeed.w) * near;
  vWarm = step(0.93, aSeed.z);
  gl_PointSize = (1.0 + 2.4 * aSeed.z * aSeed.z * aSeed.z) * uPx * (1.0 - 0.4 * life);
  gl_Position = projectionMatrix * mv;
}
`;

export const SPARK_FRAG = /* glsl */ `
uniform vec3 uRim;
uniform vec3 uCore;
uniform float uDim;
varying float vA;
varying float vWarm;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  vec3 c = mix(mix(uRim, vec3(1.0), 0.35), uCore * 1.4, vWarm);
  gl_FragColor = vec4(c * a * vA * uDim * 3.0, 1.0);
}
`;

/** The warm volumetric glow behind the face: a camera-facing quad. */
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
  p.y *= 1.35;
  float d2 = dot(p, p);
  float g = exp(-d2 * 3.0) * 0.22 + exp(-d2 * 8.0) * 0.2;
  // Fade to nothing well inside the quad, so its edge never shows.
  g *= 1.0 - smoothstep(0.55, 0.98, length(p));
  vec3 c = mix(uCore, uHot, 0.35 * exp(-d2 * 6.0));
  gl_FragColor = vec4(c * g * uCoreI * uDim, 1.0);
}
`;

/** Full-screen background: deep navy, lifted behind the head, dark at the edges. */
export const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0);
}
`;

export const BG_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uBg;
uniform vec3 uBg2;
uniform vec3 uRim;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - vec2(0.5, 0.62)) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(p * vec2(0.8, 1.0));
  vec3 c = mix(uBg, uBg2, smoothstep(0.1, 1.15, r));
  c += uRim * 0.012 * exp(-r * r * 6.0);
  gl_FragColor = vec4(c, 1.0);
}
`;

/** The landscape on both sides: an undulating perspective grid of dots and lines with warm streaks. */
export const LAND_VERT = /* glsl */ `
${NOISE}
uniform float uT;
uniform float uMotion;
varying vec3 vW;
varying float vHt;
void main() {
  vec3 w = vec3(position.x, 0.0, position.y - 30.0);
  float ax = abs(w.x);
  float side = smoothstep(1.0, 4.5, ax) * (1.0 - 0.55 * smoothstep(7.0, 18.0, ax));
  float tt = uT * uMotion;
  // Ridged noise gives sharp crests; a broad swell lifts the near ranges beside the figure.
  float r1 = 1.0 - abs(g_noise(vec3(w.x * 0.11, w.z * 0.11, 0.3)));
  float r2 = 1.0 - abs(g_noise(vec3(w.x * 0.27 + 3.0, w.z * 0.27, 1.7)));
  float swell = exp(-pow((ax - 6.5) / 4.5, 2.0)) * exp(-pow((w.z + 12.0) / 9.0, 2.0));
  float nearCam = 0.3 + 0.7 * smoothstep(-1.0, -10.0, w.z);
  float wave = sin(w.x * 0.42 + tt * 0.3) * sin(w.z * 0.34 - tt * 0.24) * 0.4
             + sin(w.x * 0.16 - w.z * 0.2 + tt * 0.18) * 0.3;
  float h = side * nearCam * (0.4 + 2.1 * r1 * r1 * r1 + 0.6 * r2 * r2 + 1.6 * swell) + wave * (0.3 + 0.7 * side);
  w.y = -2.6 + h;
  vW = w;
  vHt = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

export const LAND_FRAG = /* glsl */ `
float g_h11(float n) { return fract(sin(n * 91.3458 + 17.17) * 47453.5453); }
uniform float uT;
uniform float uMotion;
uniform float uFade;
uniform vec2 uRes;
uniform vec3 uGrid;
uniform vec3 uStreak;
varying vec3 vW;
varying float vHt;
void main() {
  vec2 g = vec2(vW.x, vW.z) * 1.7;
  vec2 fw = max(fwidth(g), vec2(1e-4));
  vec2 d = (0.5 - abs(fract(g) - 0.5)) / fw;
  float lx = 1.0 - smoothstep(0.15, 1.0, d.x);
  float lz = 1.0 - smoothstep(0.15, 1.0, d.y);
  float far = smoothstep(0.55, 0.15, max(fw.x, fw.y));
  float grid = max(lx, lz) * 0.22;
  float dots = 1.0 - smoothstep(0.5, 1.7, length(d));
  // A finer grain of light points between the grid lines.
  vec2 g3 = g * 3.0;
  vec2 fw3 = max(fwidth(g3), vec2(1e-4));
  vec2 d3 = (0.5 - abs(fract(g3) - 0.5)) / fw3;
  float grain = (1.0 - smoothstep(0.3, 1.1, length(d3))) * smoothstep(0.5, 0.2, max(fw3.x, fw3.y))
              * (0.45 + 0.55 * g_h11(dot(floor(g3), vec2(7.1, 31.7))));
  float depth = -vW.z;
  float fog = exp(-depth * 0.04) * smoothstep(1.5, 6.0, depth);
  float ridge = smoothstep(0.5, 5.0, vHt);
  float side = smoothstep(1.2, 5.0, abs(vW.x));
  vec3 col = uGrid * ((grid + dots * 3.6 + grain * 3.4) * far + (1.0 - far) * 0.3) * (0.45 + 1.8 * ridge);
  // Warm light runs along a few of the lines, into the distance and across.
  float t = uT * uMotion;
  float ci = floor(g.x + 0.5);
  float hc = g_h11(ci * 3.7);
  float streak = 0.0;
  if (hc > 0.5) {
    float s = fract(g.y * 0.03 + t * (0.04 + 0.05 * hc) + hc * 9.0);
    streak += pow(s, 14.0) * lx;
  }
  float ri = floor(g.y + 0.5);
  float hr = g_h11(ri * 5.3 + 1.0);
  if (hr > 0.66) {
    float s = fract(g.x * sign(vW.x) * 0.04 - t * (0.05 + 0.04 * hr) + hr * 5.0);
    streak += pow(s, 16.0) * lz;
  }
  col += uStreak * streak * (3.0 + 4.0 * ridge) * far;
  vec2 sp = gl_FragCoord.xy / uRes - 0.5;
  float vig = smoothstep(0.85, 0.25, length(sp * vec2(1.0, 1.25)));
  gl_FragColor = vec4(col * fog * side * uFade * (0.35 + 0.65 * vig), 1.0);
}
`;
