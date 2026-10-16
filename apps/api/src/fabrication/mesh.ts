/** Triangle-soup helpers for STL files: parsing, analysis, bounded repair and writing. Pure; no I/O. */

export const MAX_TRIANGLES = 2_000_000;
export const MAX_STL_BYTES = 120 * 1024 * 1024;

export class MeshError extends Error {}

/** x0 y0 z0 x1 y1 z1 x2 y2 z2 per triangle. */
export type Triangles = Float32Array;

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface MeshReport {
  triangles: number;
  bounds: Bounds;
  degenerateTriangles: number;
  duplicateTriangles: number;
  /** Edges used by one triangle only (holes). */
  openEdges: number;
  /** Edges used by more than two triangles, or twice in the same direction (flipped/inconsistent). */
  nonManifoldEdges: number;
  watertight: boolean;
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** Downward-facing surface (steeper than 45 degrees) that does not rest on the bed. */
  overhangAreaMm2: number;
  /** Area of downward faces resting on the bed plane. */
  bedContactAreaMm2: number;
  supportsLikely: boolean;
}

function isBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < 84) return false;
  const count = buffer.readUInt32LE(80);
  return buffer.length === 84 + count * 50;
}

export function parseStl(buffer: Buffer): Triangles {
  if (buffer.length > MAX_STL_BYTES)
    throw new MeshError("Het STL-bestand is te groot.");
  if (isBinaryStl(buffer)) {
    const count = buffer.readUInt32LE(80);
    if (count < 1 || count > MAX_TRIANGLES)
      throw new MeshError("Het aantal driehoeken is ongeldig.");
    const out = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      const base = 84 + i * 50 + 12; // skip the normal
      for (let k = 0; k < 9; k++)
        out[i * 9 + k] = buffer.readFloatLE(base + k * 4);
    }
    return finite(out);
  }
  const text = buffer.toString("utf8");
  if (!/^\s*solid\b/i.test(text))
    throw new MeshError("Dit is geen geldig STL-bestand.");
  const values: number[] = [];
  const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (values.length > MAX_TRIANGLES * 9)
      throw new MeshError("Het STL-bestand heeft te veel driehoeken.");
  }
  if (values.length < 9 || values.length % 9 !== 0)
    throw new MeshError("Het STL-bestand bevat geen volledige driehoeken.");
  return finite(Float32Array.from(values));
}

function finite(data: Float32Array): Float32Array {
  for (let i = 0; i < data.length; i++)
    if (!Number.isFinite(data[i]))
      throw new MeshError("Het model bevat ongeldige coördinaten.");
  return data;
}

export function writeBinaryStl(tri: Triangles): Buffer {
  const count = tri.length / 9;
  const out = Buffer.alloc(84 + count * 50);
  out.write("NOVA fabrication", 0, "ascii");
  out.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50;
    const n = normal(tri, i);
    out.writeFloatLE(n[0], o);
    out.writeFloatLE(n[1], o + 4);
    out.writeFloatLE(n[2], o + 8);
    for (let k = 0; k < 9; k++)
      out.writeFloatLE(tri[i * 9 + k]!, o + 12 + k * 4);
  }
  return out;
}

function cross(tri: Triangles, i: number): [number, number, number] {
  const o = i * 9;
  const ax = tri[o + 3]! - tri[o]!,
    ay = tri[o + 4]! - tri[o + 1]!,
    az = tri[o + 5]! - tri[o + 2]!;
  const bx = tri[o + 6]! - tri[o]!,
    by = tri[o + 7]! - tri[o + 1]!,
    bz = tri[o + 8]! - tri[o + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function normal(tri: Triangles, i: number): [number, number, number] {
  const c = cross(tri, i);
  const length = Math.hypot(c[0], c[1], c[2]) || 1;
  return [c[0] / length, c[1] / length, c[2] / length];
}

export function boundsOf(tri: Triangles): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = tri[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

const QUANT = 1e-3; // vertices closer than a micron are the same corner
const key = (tri: Triangles, o: number) =>
  `${Math.round(tri[o]! / QUANT)},${Math.round(tri[o + 1]! / QUANT)},${Math.round(tri[o + 2]! / QUANT)}`;

export function analyzeMesh(tri: Triangles): MeshReport {
  const count = tri.length / 9;
  const bounds = boundsOf(tri);
  const edges = new Map<string, { forward: number; backward: number }>();
  const seen = new Set<string>();
  let degenerate = 0,
    duplicate = 0,
    volume = 0,
    area = 0,
    overhang = 0,
    bed = 0;
  const bedZ = bounds.min[2];
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const c = cross(tri, i);
    const twice = Math.hypot(c[0], c[1], c[2]);
    const a = twice / 2;
    const keys = [key(tri, o), key(tri, o + 3), key(tri, o + 6)];
    if (
      a < 1e-9 ||
      keys[0] === keys[1] ||
      keys[1] === keys[2] ||
      keys[0] === keys[2]
    ) {
      degenerate++;
      continue;
    }
    const signature = [...keys].sort().join("|");
    if (seen.has(signature)) {
      duplicate++;
      continue;
    }
    seen.add(signature);
    area += a;
    volume +=
      (tri[o]! * (tri[o + 4]! * tri[o + 8]! - tri[o + 5]! * tri[o + 7]!) -
        tri[o + 1]! * (tri[o + 3]! * tri[o + 8]! - tri[o + 5]! * tri[o + 6]!) +
        tri[o + 2]! * (tri[o + 3]! * tri[o + 7]! - tri[o + 4]! * tri[o + 6]!)) /
      6;
    const nz = c[2] / twice;
    if (nz < -Math.SQRT1_2) {
      const lowest = Math.max(tri[o + 2]!, tri[o + 5]!, tri[o + 8]!);
      if (lowest - bedZ < 0.05) bed += a;
      else overhang += a;
    }
    for (let e = 0; e < 3; e++) {
      const from = keys[e]!,
        to = keys[(e + 1) % 3]!;
      const forward = from < to;
      const id = forward ? `${from}>${to}` : `${to}>${from}`;
      const entry = edges.get(id) ?? { forward: 0, backward: 0 };
      if (forward) entry.forward++;
      else entry.backward++;
      edges.set(id, entry);
    }
  }
  let open = 0,
    nonManifold = 0;
  for (const { forward, backward } of edges.values()) {
    if (forward + backward === 1) open++;
    else if (forward !== 1 || backward !== 1) nonManifold++;
  }
  return {
    triangles: count,
    bounds,
    degenerateTriangles: degenerate,
    duplicateTriangles: duplicate,
    openEdges: open,
    nonManifoldEdges: nonManifold,
    watertight: open === 0 && nonManifold === 0 && count > 3,
    volumeMm3: Math.abs(volume),
    surfaceAreaMm2: area,
    overhangAreaMm2: overhang,
    bedContactAreaMm2: bed,
    // 20 mm² of steep overhang is a pragmatic threshold; a real slicer decides the final answer.
    supportsLikely: overhang > 20,
  };
}

/**
 * Bounded repair: drop degenerate and duplicate triangles and put the part on the bed, centred on
 * x/y. It does not fill holes or fix inverted shells; the report says what is left.
 */
export function repairMesh(tri: Triangles): {
  triangles: Triangles;
  removed: number;
  moved: [number, number, number];
} {
  const count = tri.length / 9;
  const keep: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const keys = [key(tri, o), key(tri, o + 3), key(tri, o + 6)];
    const c = cross(tri, i);
    if (
      Math.hypot(c[0], c[1], c[2]) / 2 < 1e-9 ||
      keys[0] === keys[1] ||
      keys[1] === keys[2] ||
      keys[0] === keys[2]
    )
      continue;
    const signature = [...keys].sort().join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    keep.push(i);
  }
  const out = new Float32Array(keep.length * 9);
  keep.forEach((index, n) =>
    out.set(tri.subarray(index * 9, index * 9 + 9), n * 9),
  );
  const b = boundsOf(out);
  const moved: [number, number, number] = [
    -(b.min[0] + b.max[0]) / 2,
    -(b.min[1] + b.max[1]) / 2,
    -b.min[2],
  ];
  for (let i = 0; i < out.length; i += 3) {
    out[i] = out[i]! + moved[0];
    out[i + 1] = out[i + 1]! + moved[1];
    out[i + 2] = out[i + 2]! + moved[2];
  }
  return { triangles: out, removed: count - keep.length, moved };
}

export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

export interface PrintabilityIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

/** Turns a mesh report into findings. A clean result is "no problem found", never a guarantee of strength or safety. */
export function printabilityIssues(
  report: MeshReport,
  volume: BuildVolume,
): PrintabilityIssue[] {
  const issues: PrintabilityIssue[] = [];
  const [x, y, z] = report.bounds.size;
  if (x > volume.x || y > volume.y || z > volume.z)
    issues.push({
      level: "error",
      code: "build_volume",
      message: `Het model (${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm) past niet in het printbed (${volume.x} × ${volume.y} × ${volume.z} mm).`,
    });
  if (report.triangles < 4)
    issues.push({
      level: "error",
      code: "empty",
      message: "Het model heeft te weinig vlakken.",
    });
  if (report.openEdges > 0)
    issues.push({
      level: "error",
      code: "not_watertight",
      message: `Het model is niet waterdicht (${report.openEdges} open randen).`,
    });
  if (report.nonManifoldEdges > 0)
    issues.push({
      level: "error",
      code: "non_manifold",
      message: `Het model heeft ${report.nonManifoldEdges} niet-manifold of omgekeerde randen.`,
    });
  if (report.degenerateTriangles > 0 || report.duplicateTriangles > 0)
    issues.push({
      level: "warning",
      code: "degenerate",
      message: `${report.degenerateTriangles} ontaarde en ${report.duplicateTriangles} dubbele driehoeken (te repareren).`,
    });
  if (report.bedContactAreaMm2 < 25 && report.triangles > 0)
    issues.push({
      level: "warning",
      code: "bed_contact",
      message:
        "Heel weinig contact met het printbed in deze stand; het model kan loskomen.",
    });
  if (report.supportsLikely)
    issues.push({
      level: "warning",
      code: "supports",
      message: `Steile overhang (${report.overhangAreaMm2.toFixed(0)} mm²): waarschijnlijk supports nodig.`,
    });
  if (report.volumeMm3 < 1)
    issues.push({
      level: "warning",
      code: "tiny",
      message: "Het volume is vrijwel nul; controleer het model.",
    });
  issues.push({
    level: "info",
    code: "scope",
    message:
      "Deze controle kijkt naar geometrie. Ze garandeert geen sterkte, pasvorm of veiligheid; dunne wanden beoordeelt de slicer.",
  });
  return issues;
}
