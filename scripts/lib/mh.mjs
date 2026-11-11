// Reading MakeHuman (CC0) base mesh and target files: OBJ with groups, and "index dx dy dz" targets.
import fs from "node:fs";

/** Parse the base OBJ: positions, and faces (vertex index lists, 0-based) per group. */
export function readObj(file) {
  const text = fs.readFileSync(file, "utf8");
  const pos = [];
  const groups = new Map();
  let cur = "default";
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.trim().split(/\s+/);
      pos.push(+x, +y, +z);
    } else if (line.startsWith("g ")) {
      cur = line.slice(2).trim();
      if (!groups.has(cur)) groups.set(cur, []);
    } else if (line.startsWith("f ")) {
      const idx = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((tok) => parseInt(tok.split("/")[0], 10) - 1);
      groups.get(cur).push(idx);
    }
  }
  return { pos: Float64Array.from(pos), groups };
}

/** Add a target to positions with a weight. */
export function applyTarget(pos, file, weight) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [i, dx, dy, dz] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(i)) continue;
    pos[i * 3] += dx * weight;
    pos[i * 3 + 1] += dy * weight;
    pos[i * 3 + 2] += dz * weight;
  }
}

/** Centroid of a group's vertices (the joint helpers are small cubes). */
export function groupCentroid(pos, faces) {
  const seen = new Set();
  let x = 0;
  let y = 0;
  let z = 0;
  for (const f of faces)
    for (const i of f)
      if (!seen.has(i)) {
        seen.add(i);
        x += pos[i * 3];
        y += pos[i * 3 + 1];
        z += pos[i * 3 + 2];
      }
  const n = seen.size || 1;
  return [x / n, y / n, z / n];
}
