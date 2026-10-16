/**
 * Parametric part templates that turn a validated parameter set into OpenSCAD source. The model
 * (through the tool schema) fills the parameters; nothing here guesses dimensions. All sizes are
 * millimetres. `expected` is the outer bounding box the generated solid must have, which the tests
 * and the validation step compare with the rendered mesh.
 */

export class DesignError extends Error {}

export interface ParamSpec {
  label: string;
  unit: "mm" | "count" | "bool";
  min: number;
  max: number;
  default: number;
}

export interface Template {
  id: TemplateId;
  title: string;
  description: string;
  params: Record<string, ParamSpec>;
  build(p: Record<string, number>): {
    scad: string;
    expected: [number, number, number];
  };
}

export type TemplateId =
  "wall_bracket" | "enclosure" | "headset_stand" | "plate";

const mm = (
  label: string,
  min: number,
  max: number,
  def: number,
): ParamSpec => ({
  label,
  unit: "mm",
  min,
  max,
  default: def,
});
const count = (
  label: string,
  min: number,
  max: number,
  def: number,
): ParamSpec => ({
  label,
  unit: "count",
  min,
  max,
  default: def,
});
const flag = (label: string, def: number): ParamSpec => ({
  label,
  unit: "bool",
  min: 0,
  max: 1,
  default: def,
});

const n = (value: number) => Number(value.toFixed(4)).toString();

/** Hole centres for `holes` screws on a width x height face, one or two columns, inset by `margin`. */
export function holeGrid(
  holes: number,
  width: number,
  height: number,
  margin: number,
): [number, number][] {
  if (holes <= 0) return [];
  const columns = holes <= 2 ? 1 : 2;
  const rows = Math.ceil(holes / columns);
  const xs = columns === 1 ? [width / 2] : [margin, width - margin];
  const ys =
    rows === 1
      ? [height / 2]
      : Array.from(
          { length: rows },
          (_, r) => margin + ((height - 2 * margin) * r) / (rows - 1),
        );
  const centres: [number, number][] = [];
  for (const y of ys) for (const x of xs) centres.push([x, y]);
  return centres.slice(0, holes);
}

const rounded = (w: number, h: number, t: number, r: number) =>
  r > 0
    ? `hull() { for (x=[${n(r)},${n(w - r)}]) for (z=[${n(r)},${n(h - r)}]) translate([x,0,z]) rotate([-90,0,0]) cylinder(r=${n(r)}, h=${n(t)}); }`
    : `cube([${n(w)},${n(t)},${n(h)}]);`;

const TEMPLATES: Template[] = [
  {
    id: "wall_bracket",
    title: "Wandbeugel",
    description:
      "L-shaped wall bracket: a back plate with screw holes and a shelf that sticks out at the bottom. Width x depth x height are the outer size.",
    params: {
      width: mm("Breedte", 20, 240, 100),
      height: mm("Hoogte van de achterplaat", 20, 240, 60),
      depth: mm("Diepte van de plank", 15, 240, 50),
      thickness: mm("Wanddikte", 2, 20, 5),
      holes: count("Aantal schroefgaten", 0, 8, 4),
      holeDiameter: mm("Gatdiameter", 2, 12, 5),
      cornerRadius: mm("Hoekradius van de achterplaat", 0, 20, 0),
    },
    build(p) {
      const q = (key: string): number => p[key] as number;
      const w = q("width"),
        h = q("height"),
        d = q("depth"),
        t = q("thickness");
      const margin = Math.max(q("holeDiameter") * 1.5, 8);
      if (
        q("holes") > 0 &&
        (w < 2 * margin + q("holeDiameter") ||
          h < 2 * margin + q("holeDiameter"))
      )
        throw new DesignError("De schroefgaten passen niet in de achterplaat.");
      if (d <= t)
        throw new DesignError("De diepte moet groter zijn dan de wanddikte.");
      if (q("cornerRadius") * 2 >= Math.min(w, h))
        throw new DesignError("De hoekradius is te groot.");
      const holes = holeGrid(q("holes"), w, h, margin)
        .map(
          ([x, z]) =>
            `translate([${n(x)},-1,${n(z)}]) rotate([-90,0,0]) cylinder(d=${n(q("holeDiameter"))}, h=${n(t + 2)});`,
        )
        .join("\n  ");
      return {
        scad: `$fn=48;
union() {
  difference() {
    ${rounded(w, h, t, q("cornerRadius"))}
  ${holes}
  }
  cube([${n(w)},${n(d)},${n(t)}]);
}
`,
        expected: [w, d, h],
      };
    },
  },
  {
    id: "plate",
    title: "Plaat met gaten",
    description: "Flat plate with optional screw holes and rounded corners.",
    params: {
      width: mm("Breedte", 10, 250, 80),
      depth: mm("Diepte", 10, 250, 50),
      thickness: mm("Dikte", 1, 30, 4),
      holes: count("Aantal gaten", 0, 8, 4),
      holeDiameter: mm("Gatdiameter", 2, 20, 5),
      cornerRadius: mm("Hoekradius", 0, 30, 3),
    },
    build(p) {
      const q = (key: string): number => p[key] as number;
      const w = q("width"),
        d = q("depth"),
        t = q("thickness");
      const margin = Math.max(q("holeDiameter") * 1.5, 6);
      if (
        q("holes") > 0 &&
        (w < 2 * margin + q("holeDiameter") ||
          d < 2 * margin + q("holeDiameter"))
      )
        throw new DesignError("De gaten passen niet in de plaat.");
      if (q("cornerRadius") * 2 >= Math.min(w, d))
        throw new DesignError("De hoekradius is te groot.");
      const r = q("cornerRadius");
      const body =
        r > 0
          ? `hull() { for (x=[${n(r)},${n(w - r)}]) for (y=[${n(r)},${n(d - r)}]) translate([x,y,0]) cylinder(r=${n(r)}, h=${n(t)}); }`
          : `cube([${n(w)},${n(d)},${n(t)}]);`;
      const holes = holeGrid(q("holes"), w, d, margin)
        .map(
          ([x, y]) =>
            `translate([${n(x)},${n(y)},-1]) cylinder(d=${n(q("holeDiameter"))}, h=${n(t + 2)});`,
        )
        .join("\n  ");
      return {
        scad: `$fn=48;
difference() {
  ${body}
  ${holes}
}
`,
        expected: [w, d, t],
      };
    },
  },
  {
    id: "enclosure",
    title: "Behuizing",
    description:
      "Open box (optionally with a separate flat lid printed beside it). Width/depth/height are the INNER size; the wall comes on top.",
    params: {
      innerWidth: mm("Binnenbreedte", 10, 200, 60),
      innerDepth: mm("Binnendiepte", 10, 200, 40),
      innerHeight: mm("Binnenhoogte", 5, 200, 25),
      wall: mm("Wanddikte", 1.2, 10, 2),
      lid: flag("Deksel erbij", 1),
    },
    build(p) {
      const q = (key: string): number => p[key] as number;
      const iw = q("innerWidth"),
        id = q("innerDepth"),
        ih = q("innerHeight"),
        t = q("wall");
      const ow = iw + 2 * t,
        od = id + 2 * t,
        oh = ih + t;
      const gap = 5;
      const lid = q("lid") >= 0.5;
      const lidScad = lid
        ? `translate([${n(ow + gap)},0,0]) cube([${n(ow)},${n(od)},${n(t)}]);`
        : "";
      return {
        scad: `$fn=48;
difference() {
  cube([${n(ow)},${n(od)},${n(oh)}]);
  translate([${n(t)},${n(t)},${n(t)}]) cube([${n(iw)},${n(id)},${n(ih + 1)}]);
}
${lidScad}
`,
        expected: [lid ? ow * 2 + gap : ow, od, oh],
      };
    },
  },
  {
    id: "headset_stand",
    title: "Headsetstandaard",
    description:
      "Desk headset stand: a flat base, a vertical post at the back and a forward arm on top that the headband rests on.",
    params: {
      baseWidth: mm("Breedte van de voet", 60, 220, 120),
      baseDepth: mm("Diepte van de voet", 60, 220, 110),
      baseThickness: mm("Dikte van de voet", 3, 20, 6),
      postWidth: mm("Breedte van de paal", 15, 80, 30),
      postDepth: mm("Dikte van de paal", 8, 60, 14),
      postHeight: mm("Totale hoogte", 120, 240, 220),
      armLength: mm("Lengte van de arm naar voren", 20, 120, 60),
      armThickness: mm("Dikte van de arm", 5, 30, 12),
      cornerRadius: mm("Hoekradius van de voet", 0, 30, 8),
    },
    build(p) {
      const q = (key: string): number => p[key] as number;
      const bw = q("baseWidth"),
        bd = q("baseDepth"),
        bt = q("baseThickness"),
        pw = q("postWidth"),
        pd = q("postDepth"),
        ph = q("postHeight"),
        al = q("armLength"),
        at = q("armThickness");
      // The arm reaches `al` in front of the post, so the post stands `al` back from the front edge of the base.
      const postY = al;
      if (postY + pd > bd)
        throw new DesignError(
          "De paal en de arm passen niet op de voet; maak de voet dieper of de arm korter.",
        );
      if (pw > bw) throw new DesignError("De paal is breder dan de voet.");
      if (ph <= bt + at)
        throw new DesignError("De standaard is te laag voor voet en arm.");
      if (q("cornerRadius") * 2 >= Math.min(bw, bd))
        throw new DesignError("De hoekradius is te groot.");
      const r = q("cornerRadius");
      const base =
        r > 0
          ? `hull() { for (x=[${n(r)},${n(bw - r)}]) for (y=[${n(r)},${n(bd - r)}]) translate([x,y,0]) cylinder(r=${n(r)}, h=${n(bt)}); }`
          : `cube([${n(bw)},${n(bd)},${n(bt)}]);`;
      const px = (bw - pw) / 2;
      // The arm's footprint stays on the base, so the part prints without supports under it.
      const armY = 0;
      return {
        scad: `$fn=48;
union() {
  ${base}
  translate([${n(px)},${n(postY)},0]) cube([${n(pw)},${n(pd)},${n(ph)}]);
  translate([${n(px)},${n(armY)},${n(ph - at)}]) cube([${n(pw)},${n(postY + pd - armY)},${n(at)}]);
}
`,
        expected: [bw, bd, ph],
      };
    },
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export function getTemplate(id: string): Template {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new DesignError(`Onbekend ontwerpsjabloon "${id}".`);
  return template;
}

export function listTemplates() {
  return TEMPLATES.map(({ id, title, description, params }) => ({
    id,
    title,
    description,
    params,
  }));
}

/** Fills defaults, rejects unknown keys and out-of-range numbers. */
export function normalizeParams(
  template: Template,
  given: Record<string, unknown> | undefined,
  base?: Record<string, number>,
): Record<string, number> {
  const input = given ?? {};
  for (const key of Object.keys(input))
    if (!(key in template.params))
      throw new DesignError(`"${key}" is geen parameter van ${template.id}.`);
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(template.params)) {
    const raw = key in input ? input[key] : (base?.[key] ?? spec.default);
    const value = typeof raw === "boolean" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new DesignError(`"${key}" moet een getal zijn.`);
    if (value < spec.min || value > spec.max)
      throw new DesignError(
        `${spec.label} (${key}) moet tussen ${spec.min} en ${spec.max} liggen.`,
      );
    out[key] = spec.unit === "count" ? Math.round(value) : value;
  }
  return out;
}

const FORBIDDEN =
  /\b(include|use|import|surface|render\s*\(\s*convexity\s*=\s*0)\b|<\s*[^>]*\.[a-z0-9]{2,4}\s*>/i;
export const MAX_SCAD_BYTES = 64 * 1024;

/** Custom OpenSCAD is accepted, but cannot reach for files; the sandbox has none and no network. */
export function checkCustomScad(source: string): string {
  if (!source.trim()) throw new DesignError("De OpenSCAD-code is leeg.");
  if (Buffer.byteLength(source) > MAX_SCAD_BYTES)
    throw new DesignError("De OpenSCAD-code is te lang (maximaal 64 KB).");
  if (FORBIDDEN.test(source))
    throw new DesignError(
      "include, use, import en surface zijn niet toegestaan in eigen OpenSCAD-code.",
    );
  if (source.includes("\0"))
    throw new DesignError("Ongeldige tekens in de code.");
  return source;
}
