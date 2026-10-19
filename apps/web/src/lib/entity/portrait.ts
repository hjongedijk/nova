/** A human bust sampled as latitude contours, in the orb's normalized 3D space. */
export const PORTRAIT_COLUMNS = 32;
export const PORTRAIT_ROWS = 44;
const HEAD_ROWS = 28;
const NECK_ROWS = 6;

export function portraitPoint(
  row: number,
  column: number,
): [number, number, number] {
  const angle = (column / PORTRAIT_COLUMNS) * Math.PI * 2;
  let y: number, width: number, depth: number;
  if (row < HEAD_ROWS) {
    const v = -0.98 + (row / (HEAD_ROWS - 1)) * 1.96;
    y = -0.5 + v * 0.78;
    const profile = Math.sqrt(Math.max(0, 1 - v * v));
    width = 0.55 * profile * (v > 0.2 ? 1 - (v - 0.2) * 0.27 : 1);
    depth = 0.39 * profile;
  } else if (row < HEAD_ROWS + NECK_ROWS) {
    const u = (row - HEAD_ROWS) / (NECK_ROWS - 1);
    y = 0.24 + u * 0.39;
    width = 0.15 + u * 0.07;
    depth = 0.15 + u * 0.04;
  } else {
    const u =
      (row - HEAD_ROWS - NECK_ROWS) /
      (PORTRAIT_ROWS - HEAD_ROWS - NECK_ROWS - 1);
    y = 0.66 + u * 0.7;
    width = 0.24 + Math.sin((Math.min(1, u / 0.55) * Math.PI) / 2) * 0.92;
    depth = 0.19 + u * 0.19;
  }
  const x = Math.sin(angle) * width;
  let z = Math.cos(angle) * depth;
  if (row < HEAD_ROWS && Math.cos(angle) > 0) {
    // The face is modeled in depth, without drawn eyes or a mask: eye sockets,
    // bridge, nose, lips and chin deform the same luminous contour lines.
    const bump = (cx: number, cy: number, sx: number, sy: number) =>
      Math.exp(-(((x - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);
    const front = Math.cos(angle) ** 2;
    z +=
      front *
      (0.12 * bump(0, -0.25, 0.09, 0.27) +
        0.12 * bump(0, -0.1, 0.1, 0.09) -
        0.065 *
          (bump(-0.19, -0.37, 0.1, 0.085) + bump(0.19, -0.37, 0.1, 0.085)) +
        0.035 * bump(0, 0.06, 0.18, 0.04));
  }
  return [x, y, z];
}
