import { writeBinaryStl, type Triangles } from "../../src/fabrication/mesh.js";

/** Outward-facing triangles of an axis-aligned box from (x0,y0,z0) spanning a x b x c. */
export function boxTriangles(
  a: number,
  b: number,
  c: number,
  x0 = 0,
  y0 = 0,
  z0 = 0,
): Triangles {
  const P = (x: number, y: number, z: number): [number, number, number] => [
    x0 + x,
    y0 + y,
    z0 + z,
  ];
  const faces: [number, number, number][][] = [
    [P(0, 0, 0), P(0, b, 0), P(a, b, 0)],
    [P(0, 0, 0), P(a, b, 0), P(a, 0, 0)],
    [P(0, 0, c), P(a, 0, c), P(a, b, c)],
    [P(0, 0, c), P(a, b, c), P(0, b, c)],
    [P(0, 0, 0), P(a, 0, 0), P(a, 0, c)],
    [P(0, 0, 0), P(a, 0, c), P(0, 0, c)],
    [P(0, b, 0), P(a, b, c), P(a, b, 0)],
    [P(0, b, 0), P(0, b, c), P(a, b, c)],
    [P(0, 0, 0), P(0, 0, c), P(0, b, c)],
    [P(0, 0, 0), P(0, b, c), P(0, b, 0)],
    [P(a, 0, 0), P(a, b, 0), P(a, b, c)],
    [P(a, 0, 0), P(a, b, c), P(a, 0, c)],
  ];
  return Float32Array.from(faces.flat(2));
}

export const boxStl = (a: number, b: number, c: number) =>
  writeBinaryStl(boxTriangles(a, b, c));
