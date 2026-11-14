import { ARRIVAL_GLSL, BIRTH, f } from "./aura-data.ts";

/**
 * Shaders for the 3D Aura: the room behind her, her near-black, matte body and hair with the light lines on it
 * (isolines of fields baked on the surface, drawn at native resolution), the loose strands of hair, the star
 * points, and the birth particles. Everything here is meant to be tuned by eye.
 */

/** The colours of the lines that run warm. */
export const LINES = { warmColour: "#ffb27a", amberColour: "#ffcf73" } as const;

/** The weave: light lines drawn as isolines of fields baked on the surface (scripts/aura-figure.mjs). */
export const WEAVE = {
  /** Distance between neighbouring lines on the torso, neck and face (m), and round the arms. */
  spacing: 0.0065,
  armSpacing: 0.03,
  neckSpacing: 0.0075,
  /** The middle of each breast stays calm: no lines nearer its apex than this (m). */
  calm: 0.03,
  /** Line thickness range in CSS pixels, and core and halo strength. */
  thin: 0.55,
  thick: 1.7,
  core: 1.5,
  halo: 0.17,
  /** Share of lines that run warm (gold, peach). */
  warm: 0.3,
  /** How much of the weave shows: chest, waist, arms, face. */
  chest: 0.8,
  waist: 0.62,
  arms: 0.85,
  armGain: 0.8,
  face: 0.45,
  faceGain: 0.45,
} as const;

/** The hair mass: how far the tips sway in the wind (m per unit of wind) and ripple on their own (m). */
export const SWAY = { wind: 0.0045, most: 0.022, ripple: 0.0022 } as const;

/** The body: near-black and matte; only its silhouette and its star dust light it. */
export const SKIN = {
  base: "#06030c",
  rim: 1.1,
  sparkle: 1.3,
} as const;

/** The hair's strands: streamlines baked on the sculpted hair, drawn as thin ribbons of light. */
export const STRANDLOOK = {
  /** Core width range in device pixels, and overall strength. */
  thin: 0.5,
  thick: 0.95,
  gain: 0.3,
  /** Share of strands that are gold. */
  gold: 0.2,
  /** How much brighter the tips are than the lengths. */
  tips: 0.9,
  /** Share of the strands each GPU class draws. */
  share: { low: 0.4, mid: 0.75, high: 1 },
} as const;

/** The loose strands of hair. */
export const HAIRLOOK = {
  width: 0.00032,
  gain: 0.2,
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

/**
 * How the hair moves, for the sculpted mass and for its strands alike: on the skull it turns with the head; its
 * lengths follow a little late (a lagging copy of the head's turn) and sway in the wind, more toward the tips.
 * `rest` is the point at rest, `head` its head weight, `hair` 1 for hair. Needs uT and uMotion.
 */
const HAIRMOVE = /* glsl */ `
uniform mat3 uHeadLag;
uniform vec2 uSway;
uniform float uWaist;
vec3 hairMove(vec3 p, vec3 rest, float head, float hair) {
  vec3 hp = headXform(p, head);
  float lengths = hair * (1.0 - smoothstep(uPivot.y - 0.02, uPivot.y + 0.16, rest.y));
  hp = mix(hp, mix(p, uPivot + uHeadLag * (p - uPivot), head), lengths);
  float tip = hair * (1.0 - smoothstep(uWaist + 0.1, uPivot.y + 0.08, rest.y));
  tip *= tip;
  hp.xz += uSway * tip;
  hp.x += sin(uT * 1.3 + rest.y * 14.0 + rest.x * 5.0) * ${f(SWAY.ripple)} * tip * uMotion;
  return hp;
}
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
attribute float _hair;
attribute float _fa;
attribute float _fb;
attribute float _arm;
uniform float uBreath;
uniform float uT;
uniform float uMotion;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying float vHead;
varying float vHair;
varying float vFa;
varying float vFb;
varying float vArm;
${COMMON}
${HAIRMOVE}
void main() {
  vec3 p = position + normal * _breath * uBreath * ${f(BREATH.amount)};
  vec3 hp = hairMove(p, position, _head, _hair);
  vec3 n = normalize(mix(normal, uHead * normal, _head));
  vec4 w = modelMatrix * vec4(hp, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vObj = position;
  vHead = _head;
  vHair = _hair;
  vFa = _fa;
  vFb = _fb;
  vArm = _arm;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const BODY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObj;
varying float vHead;
varying float vHair;
varying float vFa;
varying float vFb;
varying float vArm;
uniform float uPx;
uniform float uShoulder;
uniform vec3 uFaceRest;
uniform float uWaist;
uniform vec3 uElbowL;
uniform vec3 uElbowR;
uniform float uChin;
uniform vec3 uBreastL;
uniform vec3 uBreastR;
${COMMON}
${MOOD}
/*
 * One family of light lines: the isolines of a surface field g (in line units). Measured with screen-space
 * derivatives, so every line is about a device pixel wide and razor sharp at any resolution, and follows the form
 * by construction. Each line has its own brightness, thickness and colour (a hash of its index); some are
 * missing where the weave is sparse; light pulses travel along them; where they thin out they break into dashes.
 */
vec3 weave(float g, float fam, float density, float along, vec3 A, vec3 B, float accent) {
  float id = floor(g + 0.5);
  float fw = max(fwidth(g), 1e-6);
  float dpx = abs(g - id) / fw;
  float h1 = hash11(id * 3.71 + fam);
  float h2 = hash11(id * 9.13 + fam * 2.0 + 0.3);
  float h3 = hash11(id * 5.27 + fam * 3.0 + 0.7);
  float h4 = hash11(id * 1.93 + fam * 5.0 + 0.1);
  float keep = step(1.0 - density, h1);
  float wpx = mix(${f(WEAVE.thin)}, ${f(WEAVE.thick)}, h2 * h2) * uPx;
  float core = exp(-pow(dpx / wpx, 2.0));
  float halo = exp(-pow(dpx / (wpx * 2.5 + 1.5), 2.0));
  // Lines closer together than a few pixels (grazing surfaces) fade instead of smearing.
  float crowd = 1.0 - smoothstep(0.22, 0.5, fw);
  float bright = 0.08 + 0.92 * h3 * h3 * h3;
  float swell = 0.5 + 0.5 * noise(vec2(along * 0.3 + h1 * 20.0, id * 0.7));
  float pulse = pow(max(0.0, sin(along * (0.5 + 0.6 * h2) - uT * uPulse * (0.7 + h1) * 1.6 * uMotion + h3 * 6.2832)), 12.0);
  // Toward the sparse regions the lines break into dashes.
  float dash = smoothstep(-0.05, 0.1, noise(vec2(along * 1.4 + h2 * 30.0, id * 1.7)) - (0.62 - density));
  vec3 c = mix(A, B, h2);
  float warmL = step(1.0 - ${f(WEAVE.warm)}, h4) * accent;
  c = mix(c, mix(${rgb(LINES.warmColour)}, ${rgb(LINES.amberColour)}, h3) * 1.5, warmL);
  return (mix(c, vec3(1.0, 0.92, 0.97), 0.6) * core * ${f(WEAVE.core)} + c * halo * ${f(WEAVE.halo)})
    * keep * bright * swell * (1.0 + 1.5 * pulse) * dash * crowd;
}

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

  vec3 base = ${rgb(SKIN.base)};
  // Near-black and matte on every device: no light falls on her, nothing shines. Her form reads from the
  // silhouette and the lines alone.
  vec3 col = base * 0.25;
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  float hairM = smoothstep(0.35, 0.65, vHair);
  // The rim: bright where the surface turns away.
  // The silhouette is a line of light: a very narrow pink-white core inside a violet halo, gold in places on
  // the shoulders and arms. Inside it the body stays near-black.
  float edgeV = 1.0 - NdV;
  float edgeCore = pow(edgeV, 9.0);
  float edgeHalo = pow(edgeV, 5.0);
  float goldZone = smoothstep(0.07, 0.13, abs(vObj.x)) * (0.5 + 0.5 * sin(vObj.y * 60.0 + vObj.x * 20.0));
  vec3 edgeC = mix(mix(vec3(1.0, 0.82, 0.97), ${rgb("#ffc27a")}, goldZone * 0.7), vec3(1.0), 0.15);
  // Surfaces facing down (under the chin, under the bust) keep their edge dark: the light comes from above.
  float down = 1.0 - smoothstep(0.25, 0.75, -N.y);
  // Not along the breasts' sides against the torso (an inner edge, not her outline).
  vec2 bl = vObj.xy - uBreastL.xy;
  vec2 br = vObj.xy - uBreastR.xy;
  float inner = mix(0.25, 1.0, smoothstep(0.03, 0.1, min(length(bl), length(br))));
  // The hair mass has only a soft violet rim: its light is its strands.
  col += (edgeC * edgeCore * 4.2 * inner * (1.0 - hairM) + mix(A, B, 0.35) * edgeHalo * ${f(SKIN.rim)} * mix(1.0, 0.16, hairM)) * glow * down;
  /* the weave: her whole body woven with light */
  {
    float accent = mix(uAccent.x, uAccent.y, inside);
    float along = vObj.y * 130.0 + vObj.x * 20.0;
    // Dense over the chest, collarbones and neck, thinning toward the waist; calm on the arms.
    float dens = mix(${f(WEAVE.waist)}, ${f(WEAVE.chest)}, smoothstep(uWaist + 0.04, uBreastL.y - 0.02, vObj.y));
    // The face: faint lines down its sides only (never down the middle), none under the hair.
    float onFace = smoothstep(0.0, 0.03, vObj.z - (uFaceRest.z - 0.075)) * (1.0 - smoothstep(uFaceRest.y + 0.07, uFaceRest.y + 0.095, vObj.y));
    // The bust's rings and arcs end at the collarbones; the neck and the face's sides carry their own lines,
    // running down beside the midline (never on it).
    float neckUp = smoothstep(uShoulder + 0.03, uPivot.y + 0.02, vObj.y);
    // The flow parts round each breast; its middle stays calm.
    float calm = mix(smoothstep(${f(WEAVE.calm - 0.008)}, ${f(WEAVE.calm + 0.004)}, vFb), 1.0, smoothstep(uShoulder - 0.06, uShoulder - 0.035, vObj.y));
    vec3 wv = weave(vFa / ${f(WEAVE.spacing)}, 1.0, dens, along, A, B, accent) * (1.0 - smoothstep(0.03, 0.2, vArm)) * (1.0 - neckUp) * calm;
    float armBand = 1.0 - smoothstep(0.03, 0.2, vArm);
    // The arms: a few calm lines along them.
    wv += weave(vFb / ${f(WEAVE.armSpacing)}, 7.0, ${f(WEAVE.arms)}, along, A, B, accent)
      * smoothstep(0.8, 0.97, vArm) * smoothstep(0.2, 0.5, NdV) * ${f(WEAVE.armGain)};
    // The neck's lines fade out before its top (no knot under the chin); the face's sides carry a few faint ones.
    float neckLines = neckUp * (1.0 - smoothstep(uPivot.y - 0.03, uPivot.y + 0.015, vObj.y)) * smoothstep(0.004, 0.01, abs(vObj.x));
    float faceLines = onFace * smoothstep(uChin + 0.012, uChin + 0.045, vObj.y) * (1.0 - smoothstep(uChin + 0.05, uChin + 0.085, vObj.y)) * smoothstep(0.03, 0.045, abs(vObj.x)) * ${f(WEAVE.faceGain)};
    wv += weave(vFb / ${f(WEAVE.neckSpacing)}, 9.0, ${f(WEAVE.face)}, along, A, B, accent) * (neckLines + faceLines) * armBand;
    wv *= 1.0 - hairM;
    // Lines turned edge-on dim a little; the rim takes over there.
    col += wv * glow * (0.45 + 0.55 * NdV);
  }
  // A faint inner glow, as if light lived under the glass.
  col += A * 0.01 * pow(NdV, 2.0) * glow;

  // Starry sparkle inside: fixed to the body, fading at the rim.
  vec3 sp = vObj * 520.0;
  vec3 cell = floor(sp);
  float h = hash31(cell);
  vec3 pt = cell + 0.5 + (vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 1.3)) - 0.5) * 0.7;
  float fw = max(length(fwidth(sp)), 1e-4);
  float sz = max(0.05, 0.42 * fw);
  // More of it inside the bust, where the lines leave room.
  float dusty = (1.0 - smoothstep(0.02, 0.07, vFb)) * (1.0 - vArm) * (1.0 - vHair) * (1.0 - smoothstep(uShoulder - 0.06, uShoulder - 0.035, vObj.y));
  // ... and near the lines, as if they shed it.
  float gA = vFa / ${f(WEAVE.spacing)};
  float nearLine = (1.0 - smoothstep(0.0, 0.3, abs(gA - floor(gA + 0.5)))) * (1.0 - hairM) * (1.0 - vArm);
  float spark = step(0.87 - 0.14 * dusty - 0.1 * nearLine, h) * (0.25 + 0.75 * pow(hash31(cell + 9.0), 3.0)) * exp(-dot(sp - pt, sp - pt) / (sz * sz)) * (1.0 - smoothstep(0.0, 0.7, F))
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

/* ---------------- the hair's strands: baked streamlines as camera-facing ribbons ---------------- */

export const STRAND_VERT = /* glsl */ `
attribute vec3 aTan;
attribute vec4 aInfo;   // along the strand (0..1), side (-1/1), random, head weight
uniform vec2 uRes;
uniform float uPx;
varying float vAcross;
varying float vT;
varying float vSeed;
varying vec3 vWorld;
${COMMON}
${MOOD}
${HAIRMOVE}
void main() {
  vec3 p = hairMove(position, position, aInfo.w, 1.0);
  vec3 q = position + aTan * 0.01;
  q = hairMove(q, q, aInfo.w, 1.0);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec4 cp = projectionMatrix * viewMatrix * wp;
  vec4 cq = projectionMatrix * viewMatrix * modelMatrix * vec4(q, 1.0);
  vec2 dir = cq.xy / cq.w * uRes - cp.xy / cp.w * uRes;
  dir = length(dir) > 1e-5 ? normalize(dir) : vec2(0.0, 1.0);
  // Wide enough for the core and its soft edge, in device pixels.
  float halfPx = 2.4 * uPx;
  cp.xy += vec2(-dir.y, dir.x) * aInfo.y * halfPx / (uRes * 0.5) * cp.w;
  vAcross = aInfo.y * 2.4;
  vT = aInfo.x;
  vSeed = aInfo.z;
  vWorld = wp.xyz;
  gl_Position = cp;
}
`;

export const STRAND_FRAG = /* glsl */ `
precision highp float;
varying float vAcross;
varying float vT;
varying float vSeed;
varying vec3 vWorld;
${COMMON}
${MOOD}
void main() {
  float h1 = hash11(vSeed * 71.3 + 0.7);
  float h2 = hash11(vSeed * 13.7 + 3.1);
  float h3 = hash11(vSeed * 37.9 + 5.3);
  float w = mix(${f(STRANDLOOK.thin)}, ${f(STRANDLOOK.thick)}, h2 * h2);
  float core = exp(-pow(vAcross / w, 2.0));
  float dist = length(vWorld - uFace);
  float inside = 1.0 - smoothstep(uBloomR - 0.05, uBloomR, dist);
  float tint = mix(uTint.x, uTint.y, inside);
  float glow = mix(uGlow.x, uGlow.y, inside) * (1.0 + uAudio * 0.4);
  vec3 c = mix(${rgb("#8c5cff")}, mix(uH0, uH1, inside), 0.35 + 0.5 * tint);
  c = mix(c, ${rgb("#ffc27a")} * 1.3, step(1.0 - ${f(STRANDLOOK.gold)}, h3));
  // Most strands are dim, some bright, a few white-hot; all brighter toward the tips.
  float bright = 0.1 + 0.9 * h1 * h1 * h1;
  c = mix(c, vec3(1.0, 0.9, 1.0), 0.55 * h1 * h1);
  float taper = smoothstep(0.0, 0.04, vT) * (1.0 - smoothstep(0.9, 1.0, vT));
  float tips = 1.0 + ${f(STRANDLOOK.tips)} * smoothstep(0.45, 1.0, vT);
  float pulse = pow(max(0.0, sin((vT * 2.2 - uT * 0.09 * uPulse * uMotion + h2 * 7.0) * 6.2832)), 16.0);
  vec3 col = c * core * bright * taper * tips * (1.0 + 1.6 * pulse) * ${f(STRANDLOOK.gain)} * glow;
  if (uTau < ${f(BIRTH.total)}) col *= smoothstep(${f(BIRTH.faceAt)}, ${f(BIRTH.faceAt + 1.2)}, uTau);
  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------- the loose strands of hair: interpolated from simulated guides ---------------- */

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
  return p + vec3(cos(a) * (0.02 * u * (0.3 + u) * (0.5 + aW.w)) + wave, 0.0, sin(a) * 0.016 * u * (0.3 + u) * (0.5 + aW.w) + wave * 0.6);
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
  float halfPx = max(px, 0.6) * 1.6;
  vCover = min(1.0, px / 0.6);
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
  float prof = exp(-d * d * 6.0);
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
  // A few bright individual strands, most dim; the crown glows too (strand lines converging at the part).
  float bright = (0.05 + 0.95 * pow(vRand, 4.0)) * (0.8 + 0.6 * smoothstep(0.2, 0.9, vT));
  float run = pow(max(0.0, sin((vT * 3.0 - uT * 0.12 * uMotion + vRand2 * 6.0) * 6.2832)), 18.0);
  // Strands lying on the skull don't overlap the way the falling lengths do: lift them so the crown glows.
  float along = smoothstep(0.0, 0.02, vT) * (1.0 - smoothstep(0.88, 1.0, vT)) * (1.0 + 2.6 * (1.0 - smoothstep(0.08, 0.35, vT)));
  vec3 col = base * bright * (0.6 + ${f(HAIRLOOK.sheen)} * sheen * 2.0) + vec3(1.0, 0.8, 1.0) * sheen * 0.25 * bright
    + ${rgb("#e05cf0")} * sheen2 * 0.4 * bright + mix(base, vec3(1.0), 0.5) * run * 0.6;
  col *= prof * along * vCover * ${f(HAIRLOOK.gain)} * glow;
  // No loose strand hangs in front of the face, the throat or the breastbone: they frame her, they do not veil her.
  float mid = vWorld.y > uPivot.y ? uFace.x : 0.0;
  float veil = smoothstep(0.0, 0.04, vWorld.z) * (1.0 - smoothstep(0.045, 0.085, abs(vWorld.x - mid)))
    * (1.0 - smoothstep(uFace.y + 0.05, uFace.y + 0.08, vWorld.y));
  col *= 1.0 - veil;
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
