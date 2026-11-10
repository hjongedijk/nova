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
varying float vWz;
void main() {
  float e = clamp((uForm - aDelay) / 0.58, 0.0, 1.0);
  e = e < 0.5 ? 4.0 * e * e * e : 1.0 - pow(-2.0 * e + 2.0, 3.0) / 2.0;
  vec3 p = position;
  // Breathing lifts the shoulders a touch more than the head.
  p.y += uBreath * (0.01 + 0.014 * (1.0 - aHead));
  vec3 bp = posePoint(p, aHead);
  vec3 bn = poseNormal(normal, aHead);
  // The chest swells along its normals as it breathes in (the head does not).
  float chest = (1.0 - aHead) * smoothstep(-1.5, -2.1, position.y) * smoothstep(-0.2, 0.25, normal.z);
  bp += bn * (uShell + uBreath * 0.012 * chest);
  vec3 op = uOrbC + aOrb * uOrbR;
  vec3 wp = mix(op, bp, e);
  vec3 wn = normalize(mix(aOrb, bn, e));
  vRest = position;
  vE = e;
  vHead = aHead;
  vWz = wp.z;
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
varying float vWz;

void main() {
  vec3 n = normalize(vN);
  vec3 vd = normalize(-vView);
  float ndv = dot(n, vd);
  float fres = 1.0 - clamp(abs(ndv), 0.0, 1.0);
  // Depth cue: surfaces turned away from the viewer (cheek sides, the shoulders' tops) sit further back,
  // so their lines are thinner, dimmer and a deeper blue, like the far lines of a ridgeline plot.
  float near = smoothstep(-0.45, 0.65, vWz);
  float face = smoothstep(0.42, 0.58, vRest.z) * smoothstep(-1.0, -0.6, vRest.y) * (1.0 - smoothstep(0.3, 0.5, abs(vRest.x)));
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
  // Line weight follows the facing ratio: hairlines where the face meets the viewer, heavier toward the
  // silhouette, so the occluding contour carries the form and the front stays readable.
  float wgt = (0.75 + 0.9 * fres * fres * (1.0 - 0.7 * face)) * (0.8 + 0.3 * near);
  float line = 1.0 - smoothstep(0.2 * wgt, 1.05 * wgt, dPx);
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
  float dotm = 1.0 - smoothstep(0.45, 1.25 + 0.35 * near, length(vec2(duPx, dPx)));
  float tw = 0.4 + 0.6 * g_h11(li * 7.31 + floor(uu) * 0.137);
  float lines = (line * 0.36 + dotm * tw * (1.0 + 0.45 * hw)) * clear + (1.0 - clear) * 0.2;
  lines *= 0.5 + 0.5 * near;

  // State: a slow scan while ready, rising bands while thinking, a fast sweep while executing,
  // an attentive head while listening, the voice spreading from the mouth while speaking.
  float idle = clamp(1.0 - uW.x - uW.y - uW.z - uW.w, 0.0, 1.0);
  float scan = exp(-pow((r.y - uScan) * 4.5, 2.0));
  float gain = 1.0 + scan * (0.45 * idle + 1.3 * uW.z);
  gain += uW.y * 1.1 * pow(max(0.0, sin(r.y * 6.0 - uT * 2.2)), 10.0);
  gain += uW.x * (0.3 + 0.2 * sin(uT * 2.2)) * hw;
  gain += speak * 0.9 * exp(-dm * 1.6);

  float coreMix = smoothstep(0.05, 0.5, core * (1.0 + 0.5 * speak));
  vec3 lc = mix(uLine, uLine2, 0.2 + 0.8 * fres * (0.4 + 0.6 * near));
  lc = mix(uLine * vec3(0.55, 0.7, 1.0), lc, 0.35 + 0.65 * near);
  // Inside the warm field the lines turn amber and brighter, never white.
  lc = mix(lc, mix(uCore, uHot, smoothstep(0.5, 1.2, core)) * 1.25, coreMix);
  gain *= 1.0 + 0.9 * coreMix;
  vec3 col = lc * lines * gain * (0.42 + 0.95 * fres * (1.0 - 0.6 * face));
  // Relief inside the face reads as shade: the hollows under the brow and beside the nose go darker.
  col *= 1.0 - 0.45 * face * smoothstep(0.08, 0.4, fres);
  col += uLine * 0.02;
  // The warm field glows behind the lines, not only through them.
  col += uCore * core * (0.16 + 0.1 * speak) + uHot * core * core * 0.05;

  // The rim: a bright edge around the silhouette that falls off inward, so it reads as light wrapping a
  // volume rather than a neon tube; brightest where the form turns furthest away.
  // Inside the face (sockets, under the brow) the surface turns away too, but that is relief, not edge:
  // there the rim stays out, so the hollows read as shade instead of glowing eyes.
  float rim = smoothstep(0.45, 0.97, fres) * (1.0 - 0.9 * face);
  col += uRim * (rim * rim * 0.95 + pow(fres, 9.0) * 0.95 * (1.0 - face));

  // Filaments like a Lichtenberg figure: trunks from the jaw down the front of the neck, fanning out from the
  // sternal notch over the collarbones. Branches only grow off a trunk and twigs only off a branch, so they
  // read as a tree, not a net; every order is thinner and cooler than the one it grows from, and they taper
  // and fade toward their tips.
  vec2 nc = vec2(r.x, r.y + 1.52);
  float vm = smoothstep(-0.55, -0.8, r.y) * smoothstep(-2.45, -1.85, r.y)
           * (1.0 - smoothstep(0.5, 1.0, ax)) * smoothstep(-0.05, 0.2, r.z);
  if (vm > 0.002) {
    float below = smoothstep(-1.3, -1.65, r.y);
    float ang = atan(nc.x, -nc.y + 0.25);
    float rad = length(nc * vec2(1.0, 1.3));
    // How far along the flow: 0 under the jaw, 1 at the far tips.
    float prog = mix(0.45 * smoothstep(-0.6, -1.5, r.y), 0.45 + 0.55 * smoothstep(0.1, 0.95, rad), below);
    float sd = mix(-r.y, 1.5 + rad, below);
    // Across the flow: x down the neck, the angle out of the notch below it. Strands are the integer lines of
    // a coordinate that only ever grows across the flow, so they kink like lightning but can never loop.
    float u = mix(r.x * 7.0, ang * 5.6, below);
    float vv = u + 0.5 * g_noise(vec3(u * 0.45, sd * 2.6, t * 0.03 + 1.0))
                 + 0.12 * g_noise(vec3(u * 1.3, sd * 10.0, 5.0));
    float fwv = max(fwidth(vv), 1e-4);
    float i = floor(vv + 0.5);
    float o = vv - i;
    float hi = g_h11(i * 3.17 + 0.5);
    float len = 0.45 + 0.55 * (hi - 0.38) / 0.62;
    float pl = prog / len;
    float alive = (1.0 - smoothstep(0.85, 1.0, pl)) * step(0.38, hi);
    float taper = mix(1.6, 0.5, clamp(pl, 0.0, 1.0));
    float trunk = 1.0 - smoothstep(0.3 * taper, 1.1 * taper, abs(o) / fwv);
    // Each strand forks once to one side, and the fork forks again back the other way, each thinner.
    float side = g_h11(i * 5.3 + 1.0) > 0.5 ? 1.0 : -1.0;
    float s1 = 0.12 + 0.3 * g_h11(i * 7.1 + 2.0);
    float d1 = side * 0.4 * smoothstep(s1, s1 + 0.3, prog) + 0.05 * g_noise(vec3(i, sd * 9.0, 2.0)) * step(s1, prog);
    float branch = (1.0 - smoothstep(0.22 * taper, 0.8 * taper, abs(o - d1) / fwv)) * step(s1, prog);
    float s2 = s1 + 0.12 + 0.25 * g_h11(i * 9.7 + 3.0);
    float d2 = d1 - side * 0.17 * smoothstep(s2, s2 + 0.25, prog);
    float twig = (1.0 - smoothstep(0.15, 0.55, abs(o - d2) / fwv)) * step(s2, prog) * (1.0 - smoothstep(0.75, 0.95, prog));
    // A soft corona around the trunks, the sharp line on top of it.
    float corona = exp(-abs(o) / fwv * 0.25 / taper) * 0.12;
    float tip = 1.0 - 0.7 * smoothstep(0.5, 1.0, pl);
    float flick = 0.6 + 0.4 * g_noise(vec3(sd * 3.0 - t * 1.4, u * 0.5, t * 0.5));
    vec3 vc = uHot * (trunk * 1.15 + corona) + mix(uCore, uHot, 0.4) * branch * 1.0 + mix(uCore, uRim, 0.3) * twig * 0.6;
    col += vc * alive * vm * tip * (1.0 - 0.6 * rim) * (0.7 + 0.6 * flick) * (1.15 + speak * 0.8);
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
  gl_FragColor = vec4(uRim * g * 0.38 * alpha * uDim * floorFade(), 1.0);
}
`;

/** Sparks: points shed from the silhouette, like hair of light from the crown. */
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
varying float vCoc;
void main() {
  float tt = uT * uMotion;
  float life = fract(tt * mix(0.05, 0.17, aSeed.y) + aSeed.x);
  vec3 p = posePoint(position, aHead);
  vec3 n = poseNormal(normal, aHead);
  float crown = smoothstep(0.25, 0.9, n.y) * aHead;
  // Out along the normal and up, then carried by the curl of a slow noise field: a divergence-free flow,
  // so the halo curls like smoke instead of jittering, and never collapses into a column over the crown.
  vec3 base = p + n * (0.012 + 0.2 * life + 0.1 * uAudio * life)
            + vec3((0.18 * n.x + 0.5 * (aSeed.y - 0.5) * crown) * life, (0.3 * crown + 0.12) * life, 0.0);
  vec3 sp = base * 1.4 + vec3(aSeed.z * 3.0, -tt * 0.12, tt * 0.05);
  const float e = 0.09;
  float dy = g_noise(sp + vec3(0.0, e, 0.0)) - g_noise(sp - vec3(0.0, e, 0.0));
  float dx = g_noise(sp + vec3(e, 0.0, 0.0)) - g_noise(sp - vec3(e, 0.0, 0.0));
  vec2 curl = vec2(dy, -dx) / (2.0 * e);
  vec3 wp = base + vec3(curl * 0.09 * life * (0.5 + crown), 0.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float near = smoothstep(-0.05, 0.25, n.z + 0.3);
  // Depth of field: away from the face plane a spark grows into a soft disc and its light spreads thin.
  vWarm = step(0.93, aSeed.z);
  float coc = clamp(abs(wp.z - 0.35) * 0.9 + life * 0.4, 0.0, 1.8) * step(0.72, aSeed.w) * (1.0 - vWarm);
  vCoc = coc;
  vLife = life;
  vA = pow(1.0 - life, 1.6) * smoothstep(0.0, 0.06, life) * uReady * (0.35 + 0.65 * aSeed.w) * near
     / (1.0 + 2.6 * coc * coc);
  gl_PointSize = (1.0 + 2.4 * aSeed.z * aSeed.z * aSeed.z) * uPx * (1.0 - 0.35 * life) * (1.0 + 1.5 * coc);
  gl_Position = projectionMatrix * mv;
}
`;

export const SPARK_FRAG = /* glsl */ `
uniform vec3 uRim;
uniform vec3 uCore;
uniform float uDim;
varying float vA;
varying float vWarm;
varying float vLife;
varying float vCoc;
void main() {
  float d = length(gl_PointCoord - 0.5);
  // In focus a soft point; out of focus a flat disc with a faint bright edge, like a lens's bokeh.
  float pt = smoothstep(0.5, 0.0, d);
  float disc = smoothstep(0.5, 0.42, d) * (0.75 + 0.25 * smoothstep(0.25, 0.46, d));
  float a = mix(pt, disc, smoothstep(0.3, 1.0, vCoc));
  // Born white-hot at the surface, cooling to the rim's blue as it drifts off.
  vec3 cool = mix(mix(uRim, vec3(1.0), 0.55), uRim, smoothstep(0.0, 0.45, vLife));
  vec3 c = mix(cool, uCore * 1.4, vWarm);
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
uniform vec3 uCore;
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
float b_fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * b_n(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
/* A field of stars on a pixel grid: one candidate per cell, most cells empty, each twinkling on its own. */
float stars(vec2 px, float cell, float seed, float density, float t) {
  vec2 g = floor(px / cell);
  vec2 f = fract(px / cell);
  float h = b_h21(g + seed);
  if (h < density) return 0.0;
  vec2 c = 0.2 + 0.6 * vec2(b_h21(g + seed + 3.1), b_h21(g + seed + 7.7));
  float d = length((f - c) * cell) / uPx;
  float tw = 0.65 + 0.35 * sin(t * (0.6 + 1.8 * b_h21(g + 1.3)) + h * 40.0);
  float big = pow(b_h21(g + 9.4), 6.0);
  return exp(-d * d / (0.35 + 1.6 * big)) * tw * (0.35 + 1.4 * big);
}
void main() {
  float asp = uRes.x / uRes.y;
  float t = uT * uMotion;
  vec2 p = (vUv - vec2(0.5, 0.62)) * vec2(asp, 1.0);
  float r = length(p * vec2(0.8, 1.0));
  vec3 c = mix(uBg, uBg2, smoothstep(0.1, 1.15, r));
  // Volumetric back light: a soft glow behind the head and shoulders, with faint slow rays out of it.
  vec2 hp = (vUv - vec2(0.5, 0.7)) * vec2(asp, 1.0);
  float hr = length(hp * vec2(0.85, 1.0));
  float ang = atan(hp.y, hp.x);
  float rays = b_n(vec2(ang * 7.0, t * 0.03)) * b_n(vec2(ang * 13.0 + 4.0, -t * 0.02));
  c += uRim * (0.03 * exp(-hr * hr * 5.0) + 0.05 * rays * rays * exp(-hr * 2.6) * smoothstep(0.12, 0.3, hr));
  // Space: a faint drifting nebula, mostly blue, warm only low near the horizon; parallax with the gaze.
  vec2 np = p * 1.5 + uPar * 0.05 + vec2(t * 0.004, -t * 0.002);
  float neb = b_fbm(np + 0.6 * b_fbm(np * 0.7 + 3.0));
  neb = smoothstep(0.42, 0.95, neb);
  float sky = smoothstep(0.42, 0.75, vUv.y);
  c += mix(uHaze * 0.15, uRim * 0.09, b_n(np * 0.8 + 9.0)) * neb * (0.35 + 0.65 * sky);
  // Stars: a dense far layer and a sparse near one that moves five times as much with the gaze; kept off
  // the figure, so the face never fills with points.
  float side = smoothstep(0.17, 0.33, abs(vUv.x - 0.5)) + smoothstep(0.82, 0.98, vUv.y);
  vec2 px = gl_FragCoord.xy;
  float st = stars(px + uPar * 6.0 * uPx, 7.0 * uPx, 0.0, 0.9, t) * 0.5
           + stars(px + uPar * 30.0 * uPx, 23.0 * uPx, 11.0, 0.93, t) ;
  c += mix(uHaze, vec3(1.0), 0.35) * st * clamp(side, 0.0, 1.0) * sky * 0.55;
  // Far ranges behind the landscape: three silhouettes, each paler and closer to the haze than the one in
  // front (atmospheric perspective), drawn as a thin lit crest over a soft fill.
  float x = (vUv.x - 0.5) * asp;
  float ax = abs(x);
  float sides = smoothstep(0.2, 0.62, ax);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float par = (0.004 + 0.006 * (2.0 - fi)) * uPar.x;
    float rx = (x + par) * (1.3 + 0.7 * fi) + fi * 7.3;
    float ridge = 1.0 - abs(2.0 * b_fbm(vec2(rx, fi * 3.0)) - 1.0);
    float hgt = 0.5 + ((0.2 - 0.045 * fi) + (0.17 - 0.03 * fi) * ridge * ridge) * sides;
    float dy = vUv.y - hgt;
    float fill = (1.0 - smoothstep(-0.002, 0.002, dy)) * smoothstep(-0.2, 0.0, dy);
    float crest = exp(-abs(dy) * uRes.y / (1.4 * uPx)) + 0.25 * exp(-abs(dy) * uRes.y / (9.0 * uPx));
    // fi 0 is the furthest: highest, palest, softest.
    vec3 tone = mix(uHaze, uRim * 0.8, 0.3 * fi);
    float far = 1.0 - fi / 2.0;
    c += tone * (fill * (0.035 * far + 0.012) + crest * (0.12 + 0.1 * fi)) * sides * uFade;
  }
  // A thin haze sits on the horizon behind everything, warmest at the sides.
  c += mix(uHaze, uCore, 0.18) * 0.045 * exp(-pow((vUv.y - 0.5) / 0.045, 2.0)) * sides * uFade;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** The landscape on both sides: an undulating perspective grid of dots and lines with warm streaks. */
export const LAND_VERT = /* glsl */ `
${NOISE}
uniform float uT;
uniform float uMotion;
uniform vec2 uPar;
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
  // Parallax with the gaze: the near ranges slide against the far ones and the sky.
  w.x -= uPar.x * 0.5;
  w.y += uPar.y * 0.12;
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
uniform vec3 uHaze;
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
  // A finer dust between those, only close by.
  vec2 g6 = g * 6.0;
  vec2 fw6 = max(fwidth(g6), vec2(1e-4));
  vec2 d6 = (0.5 - abs(fract(g6) - 0.5)) / fw6;
  float dust = (1.0 - smoothstep(0.3, 1.0, length(d6))) * smoothstep(0.45, 0.15, max(fw6.x, fw6.y))
             * step(0.55, g_h11(dot(floor(g6), vec2(3.7, 19.3))));
  grain += dust * 0.6;
  float depth = -vW.z;
  // The far edge of the plane dissolves well before it ends, so it never draws a horizon line.
  float fog = exp(-depth * 0.04) * smoothstep(1.5, 6.0, depth) * (1.0 - smoothstep(38.0, 58.0, depth));
  // Atmospheric perspective: with distance the light loses contrast and turns toward the haze colour.
  float air = smoothstep(6.0, 40.0, depth);
  float ridge = smoothstep(0.5, 5.0, vHt);
  float side = smoothstep(1.2, 5.0, abs(vW.x));
  vec3 col = mix(uGrid, uHaze * 0.8, air) * ((grid + dots * 3.6 + grain * 3.4) * far + (1.0 - far) * 0.3)
            * (0.45 + 1.8 * ridge) * (1.0 - 0.35 * air);
  col += uHaze * 0.05 * air * (0.4 + ridge);
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
  gl_FragColor = vec4(col * fog * side * uFade * (0.3 + 0.7 * vig), 1.0);
}
`;

/**
 * Final pass, in display space after tone mapping: a slight lens chromatic aberration toward the edges,
 * a colour grade (cool lifted shadows, a gentle S-curve), a vignette that frames the figure, fine film
 * grain and very faint scanlines with an analogue shimmer. No glitches, no blinking.
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
  vec2 off = d * r2 * 0.006;
  vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
  c = clamp(c, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
  c += vec3(0.002, 0.008, 0.016) * (1.0 - smoothstep(0.0, 0.25, l));
  float vig = smoothstep(1.25, 0.35, length(d * vec2(1.0, 1.15)) * 1.6);
  c *= 0.45 + 0.55 * vig;
  float t = uT * uMotion;
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y / uPx * 1.5708 - t * 2.0);
  float shimmer = 1.0 + 0.008 * sin(t * 13.0) * sin(t * 7.3 + 1.0);
  c *= (1.0 - 0.03 * scan * smoothstep(0.02, 0.2, l)) * shimmer;
  float gr = p_h(gl_FragCoord.xy + fract(t * 0.37) * 517.0) - 0.5;
  c += gr * 0.03 * (1.0 - 0.6 * l);
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
