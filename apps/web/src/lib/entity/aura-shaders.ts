import { ARRIVAL_GLSL, AURA_DATA, BIRTH, f, FACE, STARS } from "./aura-data.ts";

/**
 * The light lines drawn over the blank head and the body (their paths live in the lines raster, built by
 * scripts/aura-assets.mjs). Everything here is meant to be tuned by eye. Units: pixels of the 1920-wide raster.
 */
export const LINES = {
  /** Half-width of the hot, near-white core and of the coloured glow around it, for a line of weight 1. */
  core: 0.72,
  glow: 4.3,
  /** A wide, faint halo, as if bloomed (it ends before the raster's reach of 40 px). */
  wide: 12,
  /** Strength of core, glow and halo. */
  coreGain: 1.25,
  glowGain: 1.0,
  wideGain: 0.2,
  /** How much the brightness wanders along a line, and how many swells it has. */
  vary: 0.5,
  swells: 7,
  /** Share of each line that turns warm (peach, amber) in places. */
  warm: 0.5,
  /** Light travelling along the lines: how fast and how bright. */
  travel: { speed: 0.09, gain: 0.85 },
  /** Fine sparks along the lines and faint starry dust inside the body. */
  sparks: 0.55,
  dust: 0.3,
  /** Lines on the face are only this bright, and their glow fainter still: a whisper, never features. */
  face: 0.42,
  faceGlow: 0.25,
  /** Star points where lines meet. */
  stars: 0.5,
  /** The rim light along the silhouette. */
  rim: 0.85,
  /** Overall brightness. */
  gain: 1,
  warmColour: "#ffb27a",
  amberColour: "#ffcf73",
} as const;

/** The grade over the artwork: deep violet-magenta, a darker room with smoke and thin ribbons, glossy skin. */
export const GRADE = {
  /** Red added from blue (turns indigo violet) and how much blue stays. */
  violet: 0.2,
  blue: 0.9,
  /** The room's brightness and its smoke. */
  room: 0.55,
  smoke: "#2a1050",
  ribbon: "#b05cff",
  ribbons: 0.2,
  /** The skin: darker, with a violet sheen. */
  skin: 0.5,
  sheen: "#d6a0ff",
  gloss: 0.1,
} as const;

/** Hair shimmer and the living lights on the ribbons behind. */
export const LIGHTS = {
  shimmer: 0.2,
  ribbons: 0.45,
} as const;

/** Breath: how much the chest swells (share of its size), anchored below the frame. */
export const BREATH = { amount: 0.0045, anchor: 1.25 } as const;

const D = AURA_DATA;

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

const starList = STARS.map(([u, v]) => `vec2(${f(u)}, ${f(v)})`).join(", ");

/* ---------------- the picture: the artwork, warped by breath and the head turn, with its lines and moods ---------------- */

export const PLATE_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const PLATE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uData;
uniform sampler2D uLines;
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
uniform vec2 uAccent;    // old, new: how much of the warm accents survive (alert keeps few)
uniform float uBloomR;
uniform float uBloomEdge;
uniform float uPulse;
uniform float uAudio;
uniform float uFloor;
uniform float uView;     // 0 composed, 1 the bare artwork, 2 particles only
${COMMON}

const vec2 STAR[${STARS.length}] = vec2[](${starList});

vec3 tile(float i, vec2 p) {
  p = clamp(p, 0.5 / DATA, 1.0 - 0.5 / DATA);
  return texture2D(uData, vec2(p.x, (p.y + i) / 3.0)).rgb;
}

float noise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), u.x), u.y);
}

/*
 * One light line, MIRA-like: a hot near-white core inside a magenta-violet glow and a wide faint halo, tapered at
 * both ends, its brightness swelling and fading along its length with warm peach and amber passages, light
 * travelling along it, and fine sparks on it. d: distance to the line (raster px), t: 0..1 along it.
 */
float glowGraw(float d, float w, float px) { return exp(-pow(d / (9.0 * w + px), 2.0)); }

vec3 lightLine(float d, float t, float id, float onFace, float px, vec2 q, vec3 A, vec3 B, float accent) {
  float h1 = hash11(id * 3.7 + 1.0);
  float h2 = hash11(id * 9.1 + 4.0);
  // Tapered ends.
  float taper = pow(clamp(sin(3.14159 * t), 0.0, 1.0), 0.55) * smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.95, t);
  float w = (0.7 + 0.6 * h1) * (0.25 + 1.05 * taper);
  float along = t * ${f(LINES.swells)} + h2 * 13.0;
  float vary = 1.0 - ${f(LINES.vary)} + ${f(LINES.vary)} * noise(vec2(along, id * 5.3));
  float travel = pow(max(0.0, sin((t * 2.2 - uT * uPulse * ${f(LINES.travel.speed)} * uMotion + h1 * 5.0) * 6.2832)), 14.0);
  float core = exp(-pow(d / (${f(LINES.core)} * w + 0.55 * px), 2.0));
  float glowG = exp(-pow(d / (${f(LINES.glow)} * w + px), 2.0));
  float wideG = exp(-pow(d / (${f(LINES.wide)} * (0.6 + 0.4 * w)), 2.0)) * (1.0 - smoothstep(30.0, 39.0, d));
  float soft = mix(1.0, ${f(LINES.faceGlow)}, onFace);
  glowG *= soft;
  wideG *= soft;
  // Colour: violet to magenta per line, warm in passages.
  vec3 c = mix(A, B, smoothstep(0.25, 0.75, noise(vec2(along * 0.6 + 3.0, id))));
  // Some lines run warm (amber, peach) over most of their length; the rest warm only in passages.
  float warm = max(smoothstep(1.0 - ${f(LINES.warm)}, 1.0, noise(vec2(along * 0.8 + 11.0, id * 2.1))),
    step(0.58, h2) * (0.55 + 0.45 * noise(vec2(along * 0.5, id + 2.0)))) * accent;
  c = mix(c, mix(${rgb(LINES.warmColour)}, ${rgb(LINES.amberColour)}, h2), warm * 0.9);
  // Fine dust of light scattered close around the line.
  vec2 dcell = floor(q * DATA / 1.4);
  float hz = hash21(dcell + id * 3.0 + 9.0);
  vec2 dpt = (dcell + 0.5 + (vec2(hash21(dcell + 1.3), hash21(dcell + 5.9)) - 0.5) * 0.7) * 1.4 - q * DATA;
  float dotR = max(0.16, 0.25 * px * px);
  float scatter = step(0.84, hz) * exp(-dot(dpt, dpt) / dotR) * glowGraw(d, w, px)
    * (0.4 + 0.6 * sin(uT * (1.0 + 2.0 * hz) * uMotion + hz * 30.0));
  float lit = taper * vary * (1.0 + ${f(LINES.travel.gain)} * travel);
  // Sparks: fine dots strung along the core, twinkling.
  vec2 cell = floor(q * DATA / 2.2);
  float hs = hash21(cell + id * 7.0);
  vec2 spt = (cell + 0.5 + (vec2(hash21(cell + 2.7), hash21(cell + 8.1)) - 0.5) * 0.6) * 2.2 - q * DATA;
  float spark = step(0.78, hs) * exp(-dot(spt, spt) / max(0.3, 0.3 * px * px)) * exp(-pow(d / (1.6 + 0.6 * px), 2.0))
    * (0.5 + 0.5 * sin(uT * (1.5 + 3.0 * hs) * uMotion + hs * 50.0));
  return (mix(c, vec3(1.0, 0.88, 0.96), 0.6) * core * ${f(LINES.coreGain)} + c * glowG * ${f(LINES.glowGain)}
      + mix(c, vec3(1.0), 0.6) * spark * ${f(LINES.sparks)} + mix(c, vec3(1.0), 0.4) * scatter * 0.7) * lit
    + c * wideG * ${f(LINES.wideGain)} * (0.4 + 0.6 * taper);
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
  float unseen = 0.0;
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
      // The head keeps its outline, as a turning dome does. Where the turn would bring in its unseen back, show
      // plain dark skin instead of stretching what is there.
      float here = tile(0.0, q).g;
      float known = smoothstep(0.45, 0.85, tile(0.0, X / DATA).g);
      turned = here;
      unseen = here * (1.0 - known);
      q = mix(q, X / DATA, here * known);
    }
  }

  vec3 col = texture2D(uImage, q).rgb;
  if (uView > 0.5) {
    if (uView > 1.5) col = vec3(0.0);
    gl_FragColor = linearToOutputTexel(vec4(col * edge, 1.0));
    return;
  }
  vec3 skin = texture2D(uImage, (HEADC + vec2(0.0, 12.0)) / DATA).rgb;
  col = mix(col, skin, unseen);
  vec3 t0 = tile(0.0, q);
  vec3 t1 = tile(1.0, q);
  vec3 t2 = tile(2.0, q);
  float form = t0.r;
  float headM = t0.g;
  float bright = t0.b;
  float zone = t1.r;
  float fig = t1.b;

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
  col = mix(col, mix(col, tinted, 0.85), tint * hair * zone);
  float strand = noise(vec2(q.x * 150.0, q.y * 6.0 - uT * 0.35)) * noise(vec2(q.x * 70.0 + 3.0, q.y * 2.5 + uT * 0.21));
  col *= 1.0 + ${f(LIGHTS.shimmer)} * uMotion * hair * zone * (strand * 2.2 - 0.35) * (1.0 + uAudio * 0.6);
  // Living lights: two slow highlights drift along the bright ribbons.
  float ribbon = bright * (1.0 - zone) * smoothstep(0.05, 0.4, lum);
  float sweep = exp(-pow((q.x - fract(uT * 0.011) * 1.6 + 0.3 + 0.12 * sin(q.y * 6.0)) / 0.09, 2.0))
    + exp(-pow((q.x - 1.3 + fract(uT * 0.0085 + 0.5) * 1.6 + 0.1 * sin(q.y * 5.0 + 1.0)) / 0.07, 2.0));
  col *= 1.0 + ${f(LIGHTS.ribbons)} * uMotion * ribbon * sweep;

  /* the surface: normals, turned with the head */
  vec3 n = vec3(t2.r * 2.0 - 1.0, t2.g * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  vec3 nr = n;
  if (turned > 0.0) {
    nr = vec3(n.x * sY.y + n.z * sY.x, n.y, -n.x * sY.x + n.z * sY.y);
    nr = vec3(nr.x, nr.y * sP.y + nr.z * sP.x, -nr.y * sP.x + nr.z * sP.y);
    nr = mix(n, nr, turned);
  }
  float facing = max(nr.z, 0.0);
  // The far side of a turned head darkens.
  float farSide = clamp(1.0 - turned * max(0.0, n.z - nr.z) * 3.0, 0.25, 1.0);
  col *= mix(1.0, farSide, headM);

  /* the grade: deep violet and magenta, no blue cast; the room darker, with slow violet smoke and thin ribbons */
  float figureish = max(form, hair * zone);
  col = vec3(col.r + col.b * ${f(GRADE.violet)} * (1.0 - 0.75 * bright), col.g * 0.92, col.b * ${f(GRADE.blue)});
  vec3 smokeC = ${rgb(GRADE.smoke)};
  // Wispy smoke: a domain-warped noise, fine and dark.
  vec2 sq = q * vec2(7.0, 4.5) + vec2(uT * 0.012, -uT * 0.008) * uMotion;
  sq += 1.4 * vec2(noise(sq * 0.6 + 3.0), noise(sq * 0.6 + 9.0));
  float smoke = noise(sq) * 0.6 + noise(sq * 2.3 + 5.0) * 0.3 + noise(sq * 5.1) * 0.1;
  smoke = pow(smoke, 2.2) * 0.9;
  vec3 room = col * ${f(GRADE.room)} + smokeC * smoke * (1.0 - figureish);
  // A few long thin ribbons of light drifting through the room.
  float rib = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float yy = 0.18 + 0.3 * fi + 0.07 * sin(q.x * (3.0 + fi) + fi * 2.0 + uT * 0.03 * uMotion) + 0.04 * sin(q.x * 9.0 - fi);
    float dd = abs(q.y - yy) * DATA.y;
    rib += exp(-dd * dd / (0.35 + fi * 0.2)) * smoothstep(0.35, 0.8, noise(vec2(q.x * 5.0 + fi * 3.0, uT * 0.05))) * smoothstep(0.0, 0.25, abs(q.x - ${f(D.axis)}));
  }
  room += ${rgb(GRADE.ribbon)} * rib * ${f(GRADE.ribbons)} * (1.0 - figureish);
  col = mix(room, col, max(figureish, bright));
  // The body: darker, glossy violet-black with a soft specular sheen.
  float skinM = form * (1.0 - bright);
  col *= mix(1.0, ${f(GRADE.skin)}, skinM);
  vec3 L1 = normalize(vec3(-0.5, 0.6, 0.65));
  vec3 hv = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(nr, hv), 0.0), 72.0) + 0.3 * pow(max(dot(nr, normalize(vec3(0.6, 0.25, 0.75))), 0.0), 60.0);
  col += ${rgb(GRADE.sheen)} * spec * skinM * (1.0 - 0.7 * headM) * ${f(GRADE.gloss)};
  // Hair: brighter, more saturated strands.
  col = mix(col, col * vec3(0.98, 0.95, 1.12) * 1.1, hair * zone * (1.0 - skinM));

  /* the light lines */
  vec3 lines = vec3(0.0);
  float px = max(fwidth(q.x) * 1920.0, 0.25);
  vec2 ql = clamp(q, vec2(0.0, 0.5 / 1080.0), vec2(1.0, 1.0 - 0.5 / 1080.0));
  for (int i = 0; i < 3; i++) {
    vec3 lr = texture2D(uLines, vec2(ql.x, (ql.y + float(i)) / 3.0)).rgb;
    if (lr.r < 0.995 && lr.b > 0.0) {
      float code = floor(lr.b * 255.0 + 0.5);
      float onFace = step(1.5, mod(code, 4.0));
      lines += lightLine(lr.r * 40.0, lr.g, floor(code / 4.0), onFace, px, q, A, B, accent)
        * mix(1.0, ${f(LINES.face)}, onFace);
    }
  }
  lines *= (1.0 - unseen) * mix(1.0, farSide, turned);
  // Faint starry dust inside the body.
  vec2 dc = floor(q * DATA / 3.0);
  float hd = hash21(dc + 17.0);
  vec2 dp = (dc + 0.5 + (vec2(hash21(dc + 3.1), hash21(dc + 7.7)) - 0.5) * 0.6) * 3.0;
  float dust = step(0.93, hd) * exp(-dot(q * DATA - dp, q * DATA - dp) / 0.18)
    * (0.45 + 0.55 * sin(uT * (0.7 + 2.0 * hd) * uMotion + hd * 60.0)) * form * (1.0 - headM * 0.7);
  // Star points where lines meet: a soft core with a fine cross of light, twinkling.
  float stars = 0.0;
  for (int i = 0; i < ${STARS.length}; i++) {
    vec2 sd = (q - STAR[i]) * vec2(${f(D.aspect)}, 1.0) / 0.0045;
    float tw = 0.75 + 0.25 * sin(uT * (0.9 + float(i) * 0.37) * uMotion + float(i) * 2.1);
    stars += tw * (exp(-dot(sd, sd)) + 0.5 * exp(-sd.x * sd.x * 14.0 - sd.y * sd.y * 0.12)
      + 0.5 * exp(-sd.y * sd.y * 14.0 - sd.x * sd.x * 0.12) + 0.15 * exp(-dot(sd, sd) * 0.08));
  }
  // The rim along the silhouette, on the sides (the artwork's own rim lines carry the rest).
  float rimW = pow(1.0 - facing, mix(4.0, 7.0, turned)) * form * (1.0 - bright * 0.8) * (1.0 + turned * abs(uTurn.x) * 1.5);

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
    ignite = step(ar - 0.1, uTau) * exp(-max(0.0, uTau - ar) / 0.55) * (0.5 + hp);
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

  // The bloom's front: a soft ring of light that brightens the lines as it passes.
  float bloomRing = exp(-pow((dist - uBloomR) / 0.05, 2.0));
  float boost = glow * ${f(LINES.gain)} * (1.0 + ignite * 1.4 + bloomRing * uBloomEdge * 1.4);
  col += lines * boost;
  col += mix(A, vec3(1.0), 0.5) * dust * ${f(LINES.dust)} * glow;
  col += mix(Rc, vec3(1.0), 0.55) * stars * ${f(LINES.stars)} * glow * (1.0 - unseen);
  col += Rc * rimW * ${f(LINES.rim)} * glow * (0.5 + 0.5 * ignite);
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
