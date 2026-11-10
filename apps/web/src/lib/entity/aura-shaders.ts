import { ARRIVAL_GLSL, AURA_DATA, BIRTH, f, FACE } from "./aura-data.ts";

/**
 * The neon stripes drawn over the blank head and the body. Everything here is meant to be tuned by eye.
 * Units: "data pixels", the artwork is 960 of them wide.
 */
export const STRIPES = {
  /** Stripes across the front half of the torso (from silhouette to silhouette). */
  count: 24,
  /** Stripes across the front of the head; they meet at crown and chin like a globe's meridians. */
  headCount: 8,
  /** Lit share of each period (core plus its dots); the rest is the dark gap between stripes. */
  width: 0.42,
  /** The coloured glow around each stripe, as if bloomed (0 = none). */
  halo: 0.3,
  /** The thin, whiter neon core (it thins out where the dots thin out). */
  core: 0.5,
  /** The stripe is a string of fine glowing dots: their spacing along it (data pixels), size, and brightness. */
  dots: { step: 2.6, size: 0.85, gain: 2.2 },
  /** Share of dots that are brighter star points with a small cross of light. */
  stars: 0.07,
  /** Faint sparkle dust in the dark gaps. */
  dust: 0.28,
  /** Brightness of a stripe that faces the viewer, and how much dimmer it gets as the surface turns away. */
  gain: 0.9,
  falloff: 0.85,
  /** The bright rim at the silhouette. */
  rim: 0.5,
  /** Light travelling slowly along each stripe: glint length in data pixels, and its strength. */
  travel: { length: 170, gain: 0.9 },
  /** Share of the stripes per colour: the mood's main and second colour, then the accents. */
  mix: { a: 0.45, b: 0.27, pink: 0.11, cyan: 0.08, peach: 0.09 },
  accents: { pink: "#ff70d2", cyan: "#58e2ff", peach: "#ffb48c" },
} as const;

/** Hair shimmer and the living lights on the ribbons behind. */
export const LIGHTS = {
  shimmer: 0.2,
  ribbons: 0.45,
} as const;

/** Breath: how much the chest swells (share of its size), anchored below the frame. */
export const BREATH = { amount: 0.0045, anchor: 1.25 } as const;

const D = AURA_DATA;
const bodyPeriod = (Math.PI * D.torsoHalf * D.width) / STRIPES.count;
const headPeriod = (Math.PI * D.head.radius * D.width) / STRIPES.headCount;

function rgb(hex: string): string {
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
const vec2 DATA = vec2(${f(D.width)}, ${f(D.height)});
const vec2 HEADC = vec2(${f(D.head.cx * D.width)}, ${f(D.head.cy * D.height)});
${ARRIVAL_GLSL}
`;

/* ---------------- the picture: the artwork, warped by breath and the head turn, with stripes and moods ---------------- */

export const PLATE_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const PLATE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uData;
uniform vec4 uFrame;     // picture rect in device px from the top-left: x, y, w, h
uniform vec4 uFade;      // fade widths at the picture's visible edges: top, bottom, left, right (picture units)
uniform vec2 uRes;
uniform float uT;
uniform float uMotion;
uniform vec2 uTurn;      // yaw, pitch of the head (radians)
uniform float uBreath;
uniform float uTau;      // seconds into the birth; >= total is rest
uniform vec3 uRoom;
uniform vec3 uA0; uniform vec3 uA1; uniform vec3 uB0; uniform vec3 uB1;
uniform vec3 uR0; uniform vec3 uR1; uniform vec3 uH0; uniform vec3 uH1;
uniform vec2 uGlow;      // old, new
uniform vec2 uTint;      // old, new: how far the hair takes the mood's colour
uniform vec2 uAccent;    // old, new: how much of the accents survive (alert keeps few)
uniform float uBloomR;
uniform float uBloomEdge;
uniform float uPulse;
uniform float uAudio;
uniform float uFloor;
uniform float uView;     // 0 composed, 1 the bare artwork, 2 particles only
${COMMON}

vec3 tile(float i, vec2 p) {
  p = clamp(p, 0.5 / DATA, 1.0 - 0.5 / DATA);
  return texture2D(uData, vec2(p.x, (p.y + i) / 3.0)).rgb;
}

float noise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), u.x), u.y);
}

vec3 stripeColour(float id, vec3 A, vec3 B, float accent) {
  float h = hash11(id * 1.618 + 3.7);
  vec3 c = A;
  if (h > ${f(STRIPES.mix.a)}) c = B;
  float k = ${f(STRIPES.mix.a + STRIPES.mix.b)};
  if (h > k) c = mix(A, ${rgb(STRIPES.accents.pink)}, accent);
  k += ${f(STRIPES.mix.pink)};
  if (h > k) c = mix(B, ${rgb(STRIPES.accents.cyan)}, accent);
  k += ${f(STRIPES.mix.cyan)};
  if (h > k) c = mix(A, ${rgb(STRIPES.accents.peach)}, accent);
  return c;
}

/*
 * One neon stripe as light made of particles: a string of fine glowing dots along its centre line (some of them
 * star points that twinkle), a thin whiter core, a wide coloured glow as if bloomed, and faint dust in the gap.
 * Its density varies along its length and it breaks up into stardust where its segments end.
 * across: data px from the stripe's centre line; along: data px down the picture; s: the stripe coordinate.
 */
vec3 neonStripe(float across, float along, float s, float id, float hwd, vec3 c) {
  float px = max(fwidth(along), 1e-3);
  float tw = uMotion;
  float dens = smoothstep(0.2, 0.8, noise(vec2(id * 3.1, along / 70.0)));
  float seg = smoothstep(0.16, 0.46, noise(vec2(id * 7.3 + 11.0, along / 230.0)));
  float coreG = exp(-pow(across / (hwd * 0.16 + px * 0.6), 2.0));
  float haloG = exp(-pow(across / (hwd * 0.8), 2.0));
  float wideG = exp(-pow(across / (hwd * 1.5), 2.0));
  float dots = 0.0;
  float stars = 0.0;
  float stepD = ${f(STRIPES.dots.step)};
  float j0 = floor(along / stepD);
  for (int k = -1; k <= 1; k++) {
    float j = j0 + float(k);
    float h1 = hash21(vec2(id, j));
    float h2 = hash21(vec2(j * 1.3, id + 17.0));
    float h3 = hash21(vec2(id * 1.7 + 0.5, j * 2.1 + 3.0));
    // Fewer dots where the stripe is thin or ending; there they scatter wider: stardust.
    float keep = step(h1, mix(0.3, 0.97, dens * seg));
    float ya = (j + h2) * stepD;
    float xa = (h3 - 0.5) * hwd * mix(0.5, 2.4, 1.0 - seg);
    float r = ${f(STRIPES.dots.size)} * mix(0.55, 1.2, h2);
    float sd = max(r, px * 0.6);
    vec2 dd = vec2(across - xa, along - ya) / sd;
    float twinkle = 0.6 + 0.4 * sin(uT * (1.1 + 3.0 * h3) * tw + h1 * 40.0);
    float b = keep * (0.3 + 0.7 * h3 * h3) * twinkle * (r * r) / (sd * sd);
    dots += b * exp(-dot(dd, dd));
    if (h1 < ${f(STRIPES.stars)}) {
      float st = keep * (0.7 + 0.6 * sin(uT * (0.7 + h2) * tw + h3 * 20.0));
      stars += st * (exp(-dot(dd, dd) * 0.35) + 0.6 * exp(-dd.x * dd.x * 8.0 - dd.y * dd.y * 0.08)
        + 0.6 * exp(-dd.y * dd.y * 8.0 - dd.x * dd.x * 0.08)) * (r * r) / (sd * sd);
    }
  }
  // Sparkle dust in the gap: rare, faint, twinkling.
  vec2 cellD = floor(vec2(s, along) / 7.0);
  float hd = hash21(cellD + id * 0.0);
  vec2 pd = (cellD + 0.5 + (vec2(hash21(cellD + 3.1), hash21(cellD + 7.7)) - 0.5) * 0.7) * 7.0;
  float sdd = max(0.5, px * 0.6);
  float dust = step(0.93, hd) * exp(-dot(vec2(s, along) - pd, vec2(s, along) - pd) / (sdd * sdd))
    * (0.5 + 0.5 * sin(uT * (0.8 + 2.0 * hd) * tw + hd * 60.0)) * (1.0 - haloG);
  vec3 white = vec3(1.0);
  return mix(c, white, 0.45) * coreG * ${f(STRIPES.core)} * dens * seg
    + mix(c, white, 0.3) * dots * ${f(STRIPES.dots.gain)}
    + mix(c, white, 0.7) * stars
    + c * (haloG * ${f(STRIPES.halo)} * (0.35 + 0.65 * seg) + wideG * 0.025)
    + mix(c, white, 0.5) * dust * ${f(STRIPES.dust)};
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = (fc - uFrame.xy) / uFrame.zw;
  float edge = smoothstep(0.0, uFade.x, p.y) * smoothstep(0.0, uFade.y, 1.0 - p.y)
    * smoothstep(0.0, uFade.z, p.x) * smoothstep(0.0, uFade.w, 1.0 - p.x);
  if (edge <= 0.0) { gl_FragColor = linearToOutputTexel(vec4(uRoom, 1.0)); return; }

  vec3 t1p = tile(1.0, p);
  float figP = t1p.b;

  /* breath: the figure swells a touch about a point below the frame */
  vec2 anchor = vec2(${f(D.axis)}, ${f(BREATH.anchor)});
  float e = ${f(BREATH.amount)} * uBreath * figP;
  vec2 q = anchor + (p - anchor) / vec2(1.0 + e * 0.7, 1.0 + e);

  /* head turn: find the surface point that the turned head brings to this pixel (relief mapping on the height) */
  vec2 sY = vec2(sin(uTurn.x), cos(uTurn.x));
  vec2 sP = vec2(sin(uTurn.y), cos(uTurn.y));
  float turned = 0.0;
  if (abs(uTurn.x) + abs(uTurn.y) > 1e-4) {
    vec2 P = q * DATA;
    vec2 rel = (P - HEADC) / vec2(${f(D.head.radius * D.width * 1.3)}, ${f(D.head.radius * D.width * 1.9)});
    if (dot(rel, rel) < 1.0) {
      vec2 X = P;
      for (int i = 0; i < 6; i++) {
        float h = tile(1.0, X / DATA).g * ${f(D.hmax)} * tile(0.0, X / DATA).g;
        vec2 nx = HEADC + (P - HEADC - vec2(h * sY.x, -h * sP.x)) / vec2(sY.y, sP.y);
        X = mix(X, nx, 0.7);
      }
      // The head keeps its outline (a turning dome does); where the turn would bring in its unseen back, stay
      // on the near edge of what is there.
      float here = tile(0.0, q).g;
      for (int i = 0; i < 4; i++)
        if (tile(0.0, X / DATA).g < 0.7) X = mix(X, HEADC, 0.08);
      turned = here;
      q = mix(q, X / DATA, here);
    }
  }

  vec3 col = texture2D(uImage, q).rgb;
  if (uView > 0.5) {
    if (uView > 1.5) col = vec3(0.0);
    gl_FragColor = linearToOutputTexel(vec4(col * edge, 1.0));
    return;
  }
  vec3 t0 = tile(0.0, q);
  vec3 t1 = tile(1.0, q);
  vec3 t2 = tile(2.0, q);
  float form = t0.r;
  float headM = t0.g;
  float bright = t0.b;
  float fig = t1.b;
  float zone = 1.0 - smoothstep(0.78, 1.0, length((q - vec2(${f(D.axis)}, 0.55)) / vec2(0.27, 0.62)));

  /* the mood: a bloom spreading from the face carries the new palette and intensity */
  float dist = length((p - vec2(${f(FACE.u)}, ${f(FACE.v)})) * vec2(${f(D.aspect)}, 1.0));
  float inside = 1.0 - smoothstep(uBloomR - 0.09, uBloomR, dist);
  vec3 A = mix(uA0, uA1, inside);
  vec3 B = mix(uB0, uB1, inside);
  vec3 Rc = mix(uR0, uR1, inside);
  vec3 Hc = mix(uH0, uH1, inside);
  float glow = mix(uGlow.x, uGlow.y, inside) * (1.0 + uAudio * 0.75);
  float tint = mix(uTint.x, uTint.y, inside);
  float accent = mix(uAccent.x, uAccent.y, inside);

  /* hair and ribbons: the artwork's own light, tinted by the mood, shimmering along the strands */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float hair = bright * (1.0 - form * (1.0 - bright));
  vec3 tinted = Hc * (lum / max(1e-3, dot(Hc, vec3(0.2126, 0.7152, 0.0722))));
  // (The cyan line on the chest keeps its colour.)
  float cyanish = smoothstep(0.16, 0.28, col.g / max(1e-3, col.r + col.g + col.b));
  col = mix(col, mix(col, tinted, 0.85), tint * hair * zone * (1.0 - cyanish));
  float strand = noise(vec2(q.x * 150.0, q.y * 6.0 - uT * 0.35)) * noise(vec2(q.x * 70.0 + 3.0, q.y * 2.5 + uT * 0.21));
  col *= 1.0 + ${f(LIGHTS.shimmer)} * uMotion * hair * zone * (strand * 2.2 - 0.35) * (1.0 + uAudio * 0.6);
  // Living lights: two slow highlights drift along the bright ribbons.
  float ribbon = bright * (1.0 - zone) * smoothstep(0.05, 0.4, lum);
  float sweep = exp(-pow((q.x - fract(uT * 0.011) * 1.6 + 0.3 + 0.12 * sin(q.y * 6.0)) / 0.09, 2.0))
    + exp(-pow((q.x - 1.3 + fract(uT * 0.0085 + 0.5) * 1.6 + 0.1 * sin(q.y * 5.0 + 1.0)) / 0.07, 2.0));
  col *= 1.0 + ${f(LIGHTS.ribbons)} * uMotion * ribbon * sweep;

  /* the stripes: meridians of a rounded form, lit where the surface faces the viewer */
  float dhi = t1.r * 255.0;
  float dlo = t2.b * 255.0;
  float d = ((dhi * 256.0 + dlo) / 65535.0 - 0.5) * ${f(2 * D.dmax)};
  float s = (q.x - ${f(D.axis)}) * DATA.x + d;
  float period = mix(${f(bodyPeriod)}, ${f(headPeriod)}, step(0.5, headM));
  // Even count on the head: a gap, not a stripe, runs down the middle of the face.
  float sigma = s / period + 0.5 * step(0.5, headM);
  float id = floor(sigma + 0.5);
  float fr = sigma - id;
  float hw = ${f(STRIPES.width * 0.5)};
  // Where the lines crowd (the chin, the crown, the very edge) they fade out instead of shimmering.
  float crowd = 1.0 - smoothstep(0.25, 0.55, fwidth(sigma));
  vec3 n = vec3(t2.r * 2.0 - 1.0, t2.g * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  vec3 nr = n;
  if (turned > 0.0) {
    nr = vec3(n.x * sY.y + n.z * sY.x, n.y, -n.x * sY.x + n.z * sY.y);
    nr = vec3(nr.x, nr.y * sP.y + nr.z * sP.x, -nr.y * sP.x + nr.z * sP.y);
    nr = mix(n, nr, turned);
  }
  float facing = max(nr.z, 0.0);
  // Stripes fade out right at the silhouette, where the surface turns fully away (the rim takes over there).
  float lit = (1.0 - ${f(STRIPES.falloff)} * (1.0 - pow(facing, 1.6))) * smoothstep(0.02, 0.22, facing);
  lit += 0.22 * max(dot(nr, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
  // Shade under the chin.
  lit *= 1.0 - 0.55 * tile(0.0, q - vec2(0.0, 0.045)).g * (1.0 - headM);
  float id2 = id + step(0.5, headM) * 41.0;
  float travel = pow(max(0.0, sin((q.y * DATA.y / ${f(STRIPES.travel.length)} + (hash11(id2 + 9.0) > 0.5 ? -1.0 : 1.0) * uT * uPulse * 0.11 * uMotion + hash11(id2 + 5.0) * 7.0) * 3.14159)), 8.0);
  // The crown sits in the shadow of the hair: the head's stripes fade in below it.
  float crown = mix(1.0, smoothstep(${f(D.head.top)}, ${f(D.head.top + 0.07)}, q.y), headM);
  float surface = form * (1.0 - bright * 0.92) * crown;
  vec3 sc = stripeColour(id2, A, B, accent);
  vec3 stripe = neonStripe(fr * period, q.y * DATA.y, s, id2, hw * period, sc) * lit * crowd
    * (1.0 + ${f(STRIPES.travel.gain)} * travel) * ${f(STRIPES.gain)};
  // The rim: bright where the form turns away, more so on the far side of a turned head.
  float rimW = pow(1.0 - facing, 4.0) * (1.0 + turned * abs(uTurn.x) * 4.0);
  // Only the sides catch it: not edges that face up (the shoulder line, the crown) nor edges against the hair.
  rimW *= 1.0 - smoothstep(0.25, 0.7, n.y);
  rimW *= 1.0 - tile(0.0, q + vec2(n.x, -n.y) * 0.012).b;
  // The far side of a turned head darkens.
  float farSide = clamp(1.0 - turned * max(0.0, n.z - nr.z) * 3.0, 0.25, 1.0);
  stripe *= mix(1.0, farSide, turned);
  col *= mix(1.0, farSide, headM);

  /* birth: the picture appears where the particles have landed, the face last, then one shockwave */
  float vis = 1.0;
  float ignite = 0.0;
  vec3 extra = vec3(0.0);
  if (uTau < ${f(BIRTH.total)}) {
    float hp = tile(0.0, p).g;
    float ar = arrival(p, hp, 0.5);
    float reveal = smoothstep(ar - 0.1, ar + ${f(BIRTH.settle)}, uTau);
    // The room comes up with the figure, row by row, a touch ahead: no dark cut-out waits for the particles.
    float arRoom = ar - 0.25;
    vis = mix(smoothstep(arRoom - 0.5, arRoom + 0.5, uTau), reveal, figP);
    ignite = hp * step(ar - 0.1, uTau) * exp(-max(0.0, uTau - ar) / 0.55);
    vec2 sp = (p - vec2(${f(BIRTH.source.u)}, ${f(BIRTH.source.v)})) * vec2(${f(D.aspect)}, 1.0);
    float env = smoothstep(0.0, ${f(BIRTH.lead)}, uTau) * (1.0 - smoothstep(1.4, 2.6, uTau));
    extra += mix(A, vec3(1.0), 0.35) * env * (exp(-dot(sp, sp) / 0.0016) * 1.6 + exp(-dot(sp, sp) / 0.02) * 0.25);
    float rp = (uTau - ${f(BIRTH.ringAt)}) / ${f(BIRTH.ringTime)};
    if (rp > 0.0 && rp < 1.0) {
      float rr = (1.0 - pow(1.0 - rp, 3.0)) * 1.5;
      float ring = exp(-pow((dist - rr) / (0.03 + 0.05 * rp), 2.0)) * pow(1.0 - rp, 2.0);
      extra += mix(Rc, A, 0.4) * ring * (0.25 + 0.55 * fig);
    }
  }

  // The bloom's front: a soft ring of light that brightens the stripes as it passes.
  float bloomRing = exp(-pow((dist - uBloomR) / 0.05, 2.0));
  stripe *= glow * (1.0 + ignite * 1.6 + bloomRing * uBloomEdge * 1.4);
  col += (stripe + Rc * rimW * ${f(STRIPES.rim)} * glow * (0.5 + 0.5 * ignite)) * surface;
  // The bloom's soft glowing rim.
  col += Rc * bloomRing * uBloomEdge * (0.1 + 0.9 * fig);
  col = col * vis + extra;

  float below = 1.0 - smoothstep(uFloor - 90.0, uFloor, gl_FragCoord.y);
  col *= mix(1.0, 0.42, below * step(0.0, uFloor));
  col = mix(uRoom, col, edge);
  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
}
`;

/* ---------------- the particles: the artwork sampled into points ---------------- */

export const POINTS_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aSeed;
uniform vec4 uFrame;     // css px
uniform vec2 uView;      // css px
uniform float uPx;
uniform float uSize;     // point radius, css px
uniform float uT;
uniform float uMotion;
uniform float uTau;
uniform float uBreath;
uniform vec2 uTurn;
uniform float uGain;     // 0 composed; 1 shows the particles at full strength (the dev comparison)
uniform float uTwinkle;
uniform vec3 uFly;       // colour of a particle in flight (sRGB)
varying vec3 vCol;
${COMMON}
void main() {
  vec2 home = position.xy;
  vec2 p = home;
  float isHead = 1.0 - step(0.5, abs(aSeed.z - 1.0));
  float isBright = 1.0 - step(0.5, abs(aSeed.z - 2.0));
  vec2 anchor = vec2(${f(D.axis)}, ${f(BREATH.anchor)});
  float e = ${f(BREATH.amount)} * uBreath * aColor.a;
  p = anchor + (p - anchor) * vec2(1.0 + e * 0.7, 1.0 + e);
  float hidden = 0.0;
  if (isHead > 0.5) {
    float h = aSeed.y;
    vec2 sY = vec2(sin(uTurn.x), cos(uTurn.x));
    vec2 sP = vec2(sin(uTurn.y), cos(uTurn.y));
    vec2 P = p * DATA - HEADC;
    float z = -P.x * sY.x + h * sY.y;
    P = P * vec2(sY.y, sP.y) + vec2(h * sY.x, -h * sP.x);
    p = (HEADC + P) / DATA;
    hidden = step(z, -0.5);
  }
  float ar = arrival(home, isHead, aSeed.w);
  float launch = ar - ${f(BIRTH.flight)};
  float k = clamp((uTau - launch) / ${f(BIRTH.flight)}, 0.0, 1.0);
  vec2 src = vec2(${f(BIRTH.source.u)}, ${f(BIRTH.source.v)}) + (vec2(hash11(aSeed.x * 91.0), hash11(aSeed.x * 37.0 + 2.0)) - 0.5) * vec2(0.03, 0.02);
  vec2 mid = mix(src, p, 0.5) + vec2((aSeed.x - 0.5) * 0.42, -0.06 - 0.1 * aSeed.w);
  float ek = 1.0 - pow(1.0 - k, 3.0);
  vec2 pos = mix(mix(src, mid, ek), mix(mid, p, ek), ek);
  float landed = smoothstep(ar, ar + ${f(BIRTH.settle)}, uTau);
  float twinkle = isBright * uTwinkle * uMotion * pow(0.5 + 0.5 * sin(uT * (0.5 + aSeed.x * 1.3) + aSeed.w * 60.0), 60.0);
  float gain = step(launch, uTau) * mix(1.0, max(uGain, twinkle), landed);
  vec3 c = aColor.rgb * aColor.a;
  // In flight a point is larger; its light is spread over that size, so a dense landing does not burn out.
  float grow = 1.0 + (1.0 - k) * 0.8;
  // In flight a particle is light: its own colour plus a violet glow, brighter for the face that ignites last.
  vec3 flying = uFly * (0.22 + 0.45 * isHead) + c * 0.9;
  vCol = mix(flying, c * (1.0 + 0.5 * (1.0 - landed)), smoothstep(0.55, 1.0, k)) * gain / (grow * grow);
  if (gain < 0.003 || hidden > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec2 sc = uFrame.xy + pos * uFrame.zw;
  gl_Position = vec4(sc.x / uView.x * 2.0 - 1.0, 1.0 - sc.y / uView.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(1.5, 2.0 * uSize * uPx * grow);
}
`;

export const POINTS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // A flat-topped disc (few faint fragments: an 8-bit buffer would lose them). Its weight makes an even grid of
  // them, two cells in radius, add up to the picture.
  float k = 1.0 - smoothstep(0.4, 1.0, sqrt(r2));
  gl_FragColor = vec4(vCol * k * 0.1567, 1.0);
}
`;
