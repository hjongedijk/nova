import { buildGestalte, type GestalteGeometry } from "./gestalte-body.ts";
import { buildLand, type LandPoints } from "./gestalte-land.ts";
import { buildFigurePoints, type FigurePoints } from "./gestalte-points.ts";

/** Everything the GPU figure needs, built once per page (about 2 s of CPU, so off the main thread). */
export interface GestalteAssets {
  geo: GestalteGeometry;
  fig: FigurePoints;
  land: LandPoints;
}

export function buildAssets(): GestalteAssets {
  const geo = buildGestalte(1, 12000);
  return { geo, fig: buildFigurePoints(geo), land: buildLand() };
}

/** Every typed array in the assets, for a zero-copy transfer out of the worker. */
export function transferables(a: GestalteAssets): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const part of [a.geo, a.fig, a.land] as object[])
    for (const v of Object.values(part))
      if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  return out;
}
