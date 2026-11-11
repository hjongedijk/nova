import { ARRIVAL_GLSL, BIRTH, f } from "./aura-data.ts";

/**
 * Shaders for the 3D Aura: the room behind her, her body of dark glossy glass, the light lines on it (camera-facing
 * ribbons, anti-aliased analytically at native resolution), her hair of light strands, the star points, and the
 * birth particles. Everything here is meant to be tuned by eye.
 */

/** The light lines. Widths in metres on the body; they never get thinner than about a device pixel. */
export const LINES = {
  /** Half-width of the hot core and of the glow, for a line of weight 1. */
  core: 0.0007,
  glow: 0.003,
  coreGain: 1.35,
  glowGain: 0.5,
  /** How much the brightness wanders along a line. */
  vary: 0.5,
  swells: 6,
  /** Share of each line that runs warm in passages. */
  warm: 0.45,
  travel: { speed: 0.09, gain: 0.9 },
  sparks: 0.45,
  /** Lines on the face: faint, never features. */
  face: 0.24,
  warmColour: "#ffb27a",
  amberColour: "#ffcf73",
} as const;

/** The body: dark glossy violet glass. */
export const SKIN = {
  base: "#06030c",
  key: "#9a7cff",
  rimA: "#e05cf0",
  rimB: "#ffb08a",
  gloss: 0.18,
  rim: 0.55,
  sparkle: 0.75,
  /** The lines' light on the skin within a centimetre or two. */
  lineGlow: 0.32,
} as const;

/** The hair. */
export const HAIRLOOK = {
  width: 0.00045,
  gain: 0.11,
  sheen: 0.8,
} as const;

/** Breath: how far the chest rises along its normal (m). */
export const BREATH = { amount: 0.0035 } as const;

export function rgb(hex: string): string {
  // sRGB hex to a linear vec3 literal.
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return `vec3(${c.map((v) => v.toFixed(4)).join(", ")})`;
}

const COMMON = /* glsl */ `
float hash11(float x) { return fract(sin(x * 127.1 + 11.3) * 43758.5453); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), u.x), u.y);
}
uniform mat3 uHead;
uniform vec3 uPivot;
vec3 headXform(vec3 p, float w) { return mix(p, uPivot + uHead * (p - uPivot), w); }
${ARRIVAL_GLSL}
`;

/** The mood's colours, blooming out from the face. */
const MOOD = /* glsl */ `
uniform vec3 uA0; uniform vec3 uA1; uniform vec3 uB0; uniform vec3 uB1;
uniform vec3 uR0; uniform vec3 uR1; uniform vec3 uH0; uniform vec3 uH1;
uniform vec2 uGlow; uniform vec2 uAccent; uniform vec2 uTint;
uniform float uBloomR; uniform float uBloomEdge;
uniform vec3 uFace;
uniform float uAudio;
uniform float uPulse;
uniform float uT;
uniform float uMotion;
uniform float uTau;
uniform float uFloor;
`;

/* ---------------- the room ---------------- */

export const ROOM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.999, 1.0); }
`;

export const ROOM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform vec2 uFaceScreen;   // the face on screen (0..1)
uniform vec3 uRibbon;
${COMMON}
${MOOD}
void main() {
  vec2 q = vUv * vec2(uRes.x / uRes.y, 1.0);
  // Wispy violet smoke: a domain-warped noise, slow.
  vec2 sq = q * vec2(3.6, 3.2) + vec2(uT * 0.012, -uT * 0.008) * uMotion;
  sq += 1.4 * vec2(noise(sq * 0.6 + 3.0), noise(sq * 0.6 + 9.0));
  float smoke = noise(sq) * 0.6 + noise(sq * 2.3 + 5.0) * 0.3 + noise(sq * 5.1) * 0.1;
  smoke = pow(smoke, 2.2);
  vec3 col = vec3(0.0015, 0.0006, 0.004) + vec3(0.016, 0.004, 0.034) * smoke;
  // A soft violet light behind her.
  vec2 fd = (vUv - uFaceScreen) * vec2(uRes.x / uRes.y, 1.0);
  col += mix(uA0, uA1, 0.5) * 0.02 * exp(-dot(fd, fd) * 2.5);
  // A few long thin ribbons of light drifting through the room.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float yy = 0.2 + 0.3 * fi + 0.06 * sin(vUv.x * (3.0 + fi) + fi * 2.0 + uT * 0.03 * uMotion) + 0.035 * sin(vUv.x * 9.0 - fi);
    float dd = abs(vUv.y - yy) * uRes.y;
    float w = 0.7 + fi * 0.35;
    col += uRibbon * exp(-dd * dd / (w * w)) * 0.22 * smoothstep(0.35, 0.8, noise(vec2(vUv.x * 5.0 + fi * 3.0, uT * 0.05)));
  }
  // The birth: a glow swells at her heart; at the end one soft shockwave runs out from the face.
  if (uTau < ${f(BIRTH.total)}) {
    float rp = (uTau - ${f(BIRTH.ringAt)}) / ${f(BIRTH.ringTime)};
    if (rp > 0.0 && rp < 1.0) {
      float rr = (1.0 - pow(1.0 - rp, 3.0)) * 1.2;
      float ring = exp(-pow((length(fd) - rr) / (0.02 + 0.05 * rp), 2.0)) * pow(1.0 - rp, 2.0);
      col += mix(uR1, uA1, 0.4) * ring * 0.35;
    }
  }
  float vig = (1.0 - smoothstep(0.25, 1.25, length((vUv - 0.5) * vec2(1.0, 1.2))));
  col *= 0.55 + 0.45 * vig;
  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
  gl_FragColor.rgb += (hash21(gl_FragCoord.xy + fract(uT) * 37.0) - 0.5) / 255.0;
}
`;

/* ---------------- the body ---------------- */

export const BODY_VERT = /* glsl */ `
attribute float _head;
attribute float _breath;
attribute float _glow;
attribute float _warm;
uniform float uBreath;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying float vHead;
varying float vGlow;
varying float vWarm;
${COMMON}
void main() {
  vec3 p = position + normal * _breath * uBreath * ${f(BREATH.amount)};
  vec3 hp = headXform(p, _head);
  vec3 n = normalize(mix(normal, uHead * normal, _head));
  vec4 w = modelMatrix * vec4(hp, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vObj = position;
  vHead = _head;
  vGlow = _glow;
  vWarm = _warm;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const BODY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying float vHead;
varying float vGlow;
varying float vWarm;
uniform float uWaist;
uniform vec3 uElbowL;
uniform vec3 uElbowR;
${COMMON}
${MOOD}
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float dist = length(vWorld - uFace);
  float inside = 1.0 - smoothstep(uBloomR - 0.05, uBloomR, dist);
  vec3 A = mix(uA0, uA1, inside);
  vec3 B = mix(uB0, uB1, inside);
  vec3 Rc = mix(uR0, uR1, inside);
  float glow = mix(uGlow.x, uGlow.y, inside) * (1.0 + uAudio * 0.5);

  // Three lights: a violet key from the front left, magenta and peach rims from behind.
  vec3 L1 = normalize(vec3(-0.55, 0.65, 0.75));
  vec3 L2 = normalize(vec3(0.85, 0.25, -0.45));
  vec3 L3 = normalize(vec3(-0.85, 0.1, -0.35));
  vec3 c1 = ${rgb(SKIN.key)};
  vec3 c2 = mix(${rgb(SKIN.rimA)}, Rc, 0.5);
  vec3 c3 = ${rgb(SKIN.rimB)};
  vec3 base = ${rgb(SKIN.base)};
  // Soft diffuse from the violet key, so her volumes read (the bust, the shoulders), and a little from the rims.
  vec3 col = base * 0.25 + c1 * 0.035 * pow(max(dot(N, L1), 0.0), 1.5);
  col += c2 * 0.02 * max(dot(N, L2), 0.0) + c3 * 0.012 * max(dot(N, L3), 0.0);
  // Clearcoat: sharp highlights and a strong fresnel.
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  vec3 H1 = normalize(L1 + V);
  vec3 H2 = normalize(L2 + V);
  vec3 H3 = normalize(L3 + V);
  // Specular only as a thin sheen at grazing angles: no glossy blobs on the head or shoulders.
  vec3 spec = c1 * pow(max(dot(N, H1), 0.0), 220.0)
    + c2 * pow(max(dot(N, H2), 0.0), 120.0)
    + c3 * pow(max(dot(N, H3), 0.0), 120.0) * 0.6;
  col += spec * F * ${f(SKIN.gloss)};
  // The light comes from the lines: skin near a line takes its colour.
  vec3 lineC = mix(mix(A, B, 0.4), ${rgb("#ffb27a")}, vWarm * 0.8);
  col += lineC * pow(vGlow, 2.6) * ${f(SKIN.lineGlow)} * glow * (0.55 + 0.45 * NdV);
  // The rim: bright where the surface turns away.
  float rimF = pow(1.0 - NdV, 4.0);
  col += mix(c2, A, 0.4) * rimF * ${f(SKIN.rim)} * glow * (0.6 + 0.4 * max(dot(N, L2) + 0.5, 0.0));
  // A faint inner glow, as if light lived under the glass.
  col += A * 0.01 * pow(NdV, 2.0) * glow;

  // Starry sparkle inside: fixed to the body, fading at the rim.
  vec3 sp = vObj * 240.0;
  vec3 cell = floor(sp);
  float h = hash31(cell);
  vec3 pt = cell + 0.5 + (vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 1.3)) - 0.5) * 0.7;
  float fw = max(length(fwidth(sp)), 1e-4);
  float sz = max(0.09, 0.75 * fw);
  float spark = step(0.94, h) * (0.35 + 0.65 * smoothstep(0.0, 0.5, vGlow)) * exp(-dot(sp - pt, sp - pt) / (sz * sz)) * (1.0 - smoothstep(0.0, 0.7, F))
    * (0.5 + 0.5 * sin(uT * (0.7 + 2.0 * h) * uMotion + h * 60.0));
  col += mix(A, vec3(1.0), 0.55) * spark * ${f(SKIN.sparkle)} * (1.0 - vHead * 0.5);

  // The mood's front passing: a soft ring of light.
  float ringB = exp(-pow((dist - uBloomR) / 0.03, 2.0)) * uBloomEdge;
  col += Rc * ringB * 0.35;

  // Birth: the surface lights up where the particles have landed, the face last.
  float face = vHead * smoothstep(0.0, 0.05, vWorld.z - uFace.z + 0.06);
  float vis = 1.0;
  if (uTau < ${f(BIRTH.total)}) {
    float ar = arrival(vObj.y, face, 0.5);
    vis = smoothstep(ar - 0.1, ar + ${f(BIRTH.settle)}, uTau);
    float ignite = step(ar - 0.1, uTau) * exp(-max(0.0, uTau - ar) / 0.5);
    col += mix(A, vec3(1.0), 0.3) * ignite * (0.3 + 0.7 * face) * 0.8;
  }
  // Fade out where the bust ends (waist, elbows).
  // Where the bust ends (the waist, the elbows) she fades into the room instead of showing a cut.
  float fade = smoothstep(uWaist + 0.005, uWaist + 0.09, vObj.y)
    * smoothstep(0.012, 0.075, min(distance(vObj, uElbowL), distance(vObj, uElbowR)));
  col *= vis;
  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
  gl_FragColor.a = fade;
  gl_FragColor.rgb += (hash21(gl_FragCoord.xy + fract(uT) * 37.0) - 0.5) / 255.0;
}
`;

/* ---------------- the light lines: camera-facing ribbons on the surface ---------------- */

export const LINE_VERT = /* glsl */ `
attribute vec3 aNext;
attribute vec3 aPrev;
attribute vec4 aInfo;   // across (-1/1), t along, head weight, line length (m)
attribute vec2 aCode;   // weight/warm/face code, line id
uniform vec2 uRes;      // device px
uniform float uBreath;
uniform vec3 uChest;
varying float vAcross;
varying float vHalf;
varying float vPpu;
varying float vT;
varying float vLen;
varying float vCode;
varying float vId;
varying float vFacing;
varying vec3 vWorld;
${COMMON}
void main() {
  float hw = aInfo.z;
  vec3 n = normalize(mix(normal, uHead * normal, hw));
  // Lifted a hair off the skin (and with the breath), so the body hides them only where it is in front.
  float bw = exp(-dot(position - uChest, position - uChest) / (2.0 * 0.11 * 0.11)) * (1.0 - hw);
  float lift = 0.0016 + bw * uBreath * ${f(BREATH.amount)};
  vec3 p = headXform(position + normal * lift, hw);
  vec3 q = headXform(aNext + normal * lift, hw);
  vec3 r = headXform(aPrev + normal * lift, hw);
  vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vec4 cq = projectionMatrix * viewMatrix * vec4(q, 1.0);
  vec4 cr = projectionMatrix * viewMatrix * vec4(r, 1.0);
  vec2 sq = cq.xy / cq.w * uRes * 0.5;
  vec2 sr = cr.xy / cr.w * uRes * 0.5;
  // The direction through the neighbours on both sides: consecutive quads share their edge, never twist.
  vec2 dir = sq - sr;
  dir = length(dir) > 1e-5 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float ppu = projectionMatrix[1][1] * uRes.y * 0.5 / cp.w;
  float code = aCode.x;
  float weight = (floor(code / 4.0) - 1.0) / 41.0;
  float halfPx = max(${f(LINES.glow)} * (0.5 + 0.9 * weight) * ppu * 2.6, 3.0);
  cp.xy += perp * aInfo.x * halfPx / (uRes * 0.5) * cp.w;
  vAcross = aInfo.x * halfPx;
  vHalf = halfPx;
  vPpu = ppu;
  vT = aInfo.y;
  vLen = aInfo.w;
  vCode = code;
  vId = aCode.y;
  vFacing = dot(n, normalize(cameraPosition - p));
  vWorld = p;
  gl_Position = cp;
}
`;

export const LINE_FRAG = /* glsl */ `
precision highp float;
varying float vAcross;
varying float vHalf;
varying float vPpu;
varying float vT;
varying float vLen;
varying float vCode;
varying float vId;
varying float vFacing;
varying vec3 vWorld;
uniform float uWaist;
uniform vec3 uElbowL;
uniform vec3 uElbowR;
${COMMON}
${MOOD}
void main() {
  // Integer codes come through interpolation as 51.9999 or 52.0001: round them before decoding.
  float code = floor(vCode + 0.5);
  float lineId = floor(vId + 0.5);
  float onFace = mod(code, 2.0);
  float warmLine = mod(floor(code / 2.0), 2.0);
  float weight = (floor(code / 4.0) - 1.0) / 41.0;
  float d = abs(vAcross);
  float t = vT;
  float h1 = hash11(lineId * 3.7 + 1.0);
  float h2 = hash11(lineId * 9.1 + 4.0);
  float dist = length(vWorld - uFace);
  float inside = 1.0 - smoothstep(uBloomR - 0.05, uBloomR, dist);
  vec3 A = mix(uA0, uA1, inside);
  vec3 B = mix(uB0, uB1, inside);
  float accent = mix(uAccent.x, uAccent.y, inside);
  float glow = mix(uGlow.x, uGlow.y, inside) * (1.0 + uAudio * 0.75);
  // Tapered ends.
  float taper = pow(clamp(sin(3.14159 * t), 0.0, 1.0), 0.55) * smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.96, 1.0, t));
  // Thickness varies along each line as well as between lines.
  float w = (0.3 + 0.8 * weight) * (0.25 + 1.05 * taper) * (0.75 + 0.5 * noise(vec2(t * 4.0 + h1 * 9.0, lineId)));
  // Widths in device px: the core never thinner than about a pixel (analytic anti-aliasing).
  float coreW = max(${f(LINES.core)} * w * vPpu, 0.55);
  float glowW = max(${f(LINES.glow)} * w * vPpu, 1.4);
  float core = exp(-pow(d / coreW, 2.0));
  float glowG = exp(-pow(d / glowW, 2.0)) * (1.0 - smoothstep(vHalf * 0.75, vHalf, d));
  float along = t * ${f(LINES.swells)} + h2 * 13.0;
  float vary = 1.0 - ${f(LINES.vary)} + ${f(LINES.vary)} * noise(vec2(along, lineId * 5.3));
  float travel = pow(max(0.0, sin((t * 2.2 - uT * uPulse * ${f(LINES.travel.speed)} * uMotion + h1 * 5.0) * 6.2832)), 14.0);
  vec3 c = mix(A, B, smoothstep(0.25, 0.75, noise(vec2(along * 0.6 + 3.0, lineId))));
  float warm = max(smoothstep(1.0 - ${f(LINES.warm)}, 1.0, noise(vec2(along * 0.8 + 11.0, lineId * 2.1))),
    warmLine * (0.6 + 0.4 * noise(vec2(along * 0.5, lineId + 2.0)))) * accent;
  c = mix(c, mix(${rgb(LINES.warmColour)}, ${rgb(LINES.amberColour)}, h2), warm * 0.9);
  // Sparks strung along the line every few millimetres, sized in device pixels.
  // Sparks travel along the line.
  float s = t * vLen / 0.0035 - uT * (0.8 + 1.6 * h1) * uMotion * (h2 > 0.5 ? 1.0 : -1.0);
  float cell = floor(s);
  float hs = hash11(cell * 1.37 + lineId * 7.0);
  float alongPx = (fract(s) - 0.5) * 0.0035 * vPpu;
  float spark = step(0.72, hs) * exp(-(alongPx * alongPx + d * d) / 0.9)
    * (0.5 + 0.5 * sin(uT * (1.5 + 3.0 * hs) * uMotion + hs * 50.0));
  float lit = taper * vary * (1.0 + ${f(LINES.travel.gain)} * travel) * (0.25 + 0.75 * min(weight, 1.2));
  vec3 col = (mix(c, vec3(1.0, 0.88, 0.96), 0.62) * core * ${f(LINES.coreGain)} + c * glowG * ${f(LINES.glowGain)}
    + mix(c, vec3(1.0), 0.6) * spark * ${f(LINES.sparks)}) * lit * glow;
  col *= mix(1.0, ${f(LINES.face)}, onFace);
  // Lines on the far side of a turned head or the arms' sides fade as the surface turns away.
  col *= smoothstep(-0.12, 0.2, vFacing);
  col *= smoothstep(uWaist + 0.01, uWaist + 0.09, vWorld.y)
    * smoothstep(0.012, 0.075, min(distance(vWorld, uElbowL), distance(vWorld, uElbowR)));
  // Birth: a line appears once its part of the body has landed.
  if (uTau < ${f(BIRTH.total)}) {
    float ar = arrival(vWorld.y, onFace, 0.5);
    col *= smoothstep(ar, ar + ${f(BIRTH.settle + 0.2)}, uTau);
  }
  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- the hair: strands interpolated from simulated guides ---------------- */

export const HAIR_VERT = /* glsl */ `
attribute vec3 aGuides;  // three guide indices
attribute vec4 aW;       // weights (2, the third is the rest), random, random
attribute vec2 aK;       // point along the strand (0..1), across (-1/1)
uniform sampler2D uGuides; // points x guides, world positions
uniform float uPoints;
uniform float uGuideCount;
uniform float uT;
uniform float uMotion;
uniform vec2 uRes;
varying float vAcross;
varying float vHalf;
varying float vT;
varying float vRand;
varying float vRand2;
varying vec3 vTan;
varying vec3 vWorld;
varying float vCover;
${COMMON}
vec3 guidePt(float g, float i) {
  i = clamp(i, 0.0, uPoints - 1.0);
  return texture2D(uGuides, vec2((i + 0.5) / uPoints, (g + 0.5) / uGuideCount)).xyz;
}
vec3 guideAt(float g, float u) {
  float x = u * (uPoints - 1.0);
  float i = floor(x);
  float t = x - i;
  vec3 p0 = guidePt(g, i - 1.0);
  vec3 p1 = guidePt(g, i);
  vec3 p2 = guidePt(g, i + 1.0);
  vec3 p3 = guidePt(g, i + 2.0);
  if (i < 1.0) p0 = 2.0 * p1 - p2;
  return 0.5 * (2.0 * p1 + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t);
}
vec3 strandAt(float u) {
  float w2 = 1.0 - aW.x - aW.y;
  vec3 p = guideAt(aGuides.x, u) * aW.x + guideAt(aGuides.y, u) * aW.y + guideAt(aGuides.z, u) * w2;
  // A little volume: each strand drifts off its guides toward the tips, its own way.
  float a = aW.z * 6.2832;
  // A soft wave along the strand, and a spread toward the tips: hair, not a curtain.
  // Gentle waves along the strand (each lock its own phase), and a spread toward the tips.
  float ph = aGuides.x * 0.37 + aW.z * 1.5;
  float wave = sin(u * 9.0 + ph + uT * 0.5 * uMotion) * 0.011 * smoothstep(0.1, 0.5, u);
  return p + vec3(cos(a) * (0.014 * u * u * (0.5 + aW.w)) + wave, 0.0, sin(a) * 0.01 * u * u * (0.5 + aW.w) + wave * 0.6);
}
void main() {
  float u = aK.x;
  float du = 1.0 / 24.0;
  vec3 p = strandAt(u);
  vec3 q = strandAt(min(1.0, u + du));
  vec3 r = strandAt(max(0.0, u - du));
  vec3 tg = normalize(u < 1.0 ? q - p : p - r);
  vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vec4 cq = projectionMatrix * viewMatrix * vec4(p + tg * 0.01, 1.0);
  vec2 sp = cp.xy / cp.w * uRes * 0.5;
  vec2 sq = cq.xy / cq.w * uRes * 0.5;
  vec2 dir = sq - sp;
  dir = length(dir) > 1e-5 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float ppu = projectionMatrix[1][1] * uRes.y * 0.5 / cp.w;
  // A strand is about half a millimetre; never thinner than a pixel on screen (it then gets fainter instead).
  float px = ${f(HAIRLOOK.width)} * (0.6 + 0.8 * aW.z) * ppu;
  float halfPx = max(px, 0.75) * 2.0;
  vCover = min(1.0, px / 0.75);
  cp.xy += perp * aK.y * halfPx / (uRes * 0.5) * cp.w;
  vAcross = aK.y * halfPx;
  vHalf = halfPx;
  vT = u;
  vRand = aW.z;
  vRand2 = aW.w;
  vTan = tg;
  vWorld = p;
  gl_Position = cp;
}
`;

export const HAIR_FRAG = /* glsl */ `
precision highp float;
varying float vAcross;
varying float vHalf;
varying float vT;
varying float vRand;
varying float vRand2;
varying vec3 vTan;
varying vec3 vWorld;
varying float vCover;
${COMMON}
${MOOD}
void main() {
  float d = abs(vAcross) / vHalf;
  float prof = exp(-d * d * 4.0);
  float dist = length(vWorld - uFace);
  float inside = 1.0 - smoothstep(uBloomR - 0.05, uBloomR, dist);
  vec3 Hc = mix(uH0, uH1, inside);
  float tint = mix(uTint.x, uTint.y, inside);
  float glow = mix(uGlow.x, uGlow.y, inside) * (1.0 + uAudio * 0.4);
  vec3 base = mix(${rgb("#8c5cff")}, Hc, 0.35 + 0.5 * tint);
  base = mix(base, ${rgb("#ffc27a")}, step(0.86, vRand2) * 0.7);
  // Kajiya-Kay sheen from the violet key and the magenta rim.
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(vec3(-0.55, 0.65, 0.75));
  vec3 H = normalize(L + V);
  float th = dot(vTan, H);
  float sheen = pow(sqrt(max(0.0, 1.0 - th * th)), 90.0);
  vec3 L2 = normalize(vec3(0.85, 0.25, -0.45));
  float th2 = dot(vTan, normalize(L2 + V));
  float sheen2 = pow(sqrt(max(0.0, 1.0 - th2 * th2)), 40.0);
  // Brighter strands now and then, a light running down them, dim at the root, fading at the tip.
  // Most strands are dim (the interior), some bright, a few gold; brighter toward the tips.
  float bright = (0.18 + 0.82 * pow(vRand, 3.0)) * (0.6 + 0.7 * smoothstep(0.2, 0.9, vT));
  float run = pow(max(0.0, sin((vT * 3.0 - uT * 0.12 * uMotion + vRand2 * 6.0) * 6.2832)), 18.0);
  float along = smoothstep(0.0, 0.05, vT) * (1.0 - smoothstep(0.88, 1.0, vT));
  vec3 col = base * bright * (0.6 + ${f(HAIRLOOK.sheen)} * sheen * 2.0) + vec3(1.0, 0.8, 1.0) * sheen * 0.25 * bright
    + ${rgb("#e05cf0")} * sheen2 * 0.4 * bright + mix(base, vec3(1.0), 0.5) * run * 0.6;
  col *= prof * along * vCover * ${f(HAIRLOOK.gain)} * glow;
  if (uTau < ${f(BIRTH.total)}) col *= smoothstep(${f(BIRTH.faceAt)}, ${f(BIRTH.faceAt + 1.2)}, uTau);
  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- star points where lines meet: crisp sprites at device resolution ---------------- */

export const STAR_VERT = /* glsl */ `
attribute float aSeed;
attribute float aHead;
uniform float uPx;
varying float vTw;
${COMMON}
${MOOD}
void main() {
  vec3 p = headXform(position, aHead);
  vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vTw = 0.7 + 0.3 * sin(uT * (0.9 + aSeed * 1.7) * uMotion + aSeed * 20.0);
  if (uTau < ${f(BIRTH.total)}) vTw *= smoothstep(${f(BIRTH.ringAt - 0.6)}, ${f(BIRTH.ringAt)}, uTau);
  gl_Position = cp;
  gl_PointSize = 22.0 * uPx;
}
`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
varying float vTw;
${COMMON}
${MOOD}
void main() {
  vec2 d = (gl_PointCoord - 0.5) * 22.0;
  float core = exp(-dot(d, d) / 1.4);
  float cross = exp(-d.x * d.x * 2.2 - d.y * d.y * 0.03) + exp(-d.y * d.y * 2.2 - d.x * d.x * 0.03);
  vec3 c = mix(mix(uR0, uR1, 0.5), vec3(1.0), 0.6);
  gl_FragColor = vec4(c * (core * 1.2 + cross * 0.35) * vTw, 1.0);
}
`;

/* ---------------- the birth particles ---------------- */

export const POINTS_VERT = /* glsl */ `
attribute vec4 aSeed;   // random, head weight, random, random
uniform vec3 uSource;
uniform float uPx;
uniform float uSize;
varying vec3 vCol;
${COMMON}
${MOOD}
void main() {
  vec3 home = headXform(position, aSeed.y);
  float face = aSeed.y * smoothstep(0.0, 0.05, position.z - uFace.z + 0.06);
  float ar = arrival(position.y, face, aSeed.w);
  float launch = ar - ${f(BIRTH.flight)};
  float k = clamp((uTau - launch) / ${f(BIRTH.flight)}, 0.0, 1.0);
  vec3 src = uSource + (vec3(hash11(aSeed.x * 91.0), hash11(aSeed.x * 37.0 + 2.0), hash11(aSeed.x * 13.0 + 5.0)) - 0.5) * 0.03;
  vec3 mid = mix(src, home, 0.5) + vec3((aSeed.x - 0.5) * 0.3, 0.04 + 0.08 * aSeed.z, 0.06 + 0.1 * aSeed.z);
  float ek = 1.0 - pow(1.0 - k, 3.0);
  vec3 pos = mix(mix(src, mid, ek), mix(mid, home, ek), ek);
  float landed = smoothstep(ar, ar + ${f(BIRTH.settle)}, uTau);
  float gain = step(launch, uTau) * (1.0 - landed);
  vCol = mix(mix(uA1, vec3(1.0), 0.4), mix(uB1, vec3(1.0), 0.3), aSeed.z) * gain * (0.5 + 0.8 * face);
  vec4 cp = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  gl_Position = gain < 0.003 ? vec4(2.0, 2.0, 2.0, 1.0) : cp;
  gl_PointSize = gain < 0.003 ? 0.0 : uSize * uPx * (1.0 + (1.0 - k) * 1.5);
}
`;

export const POINTS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * (1.0 - r2) * (1.0 - r2) * 0.5, 1.0);
}
`;
