import type { VizScene, VizTile } from "../types.ts";
import { emptyLayout, type CardLayout } from "./types.ts";
import { PAD, finish, fit, markFor, toneOf } from "./common.ts";

const GAP = 8;
const TILE_H = 66;
const MIN_W = 132;

const relief = (tile: VizTile): number =>
  tile.status === "critical"
    ? 20
    : tile.status === "warning"
      ? 13
      : tile.status === "off"
        ? 3
        : 8;

/** A grid of tiles, grouped (nodes, rooms ...). The state is written out; the colour only repeats it. */
export function layoutTiles(scene: VizScene, width: number): CardLayout {
  const tiles = scene.tiles ?? [];
  const out = emptyLayout(width, 100);
  const inner = width - 2 * PAD;
  const cols = Math.max(
    1,
    Math.min(5, Math.floor((inner + GAP) / (MIN_W + GAP))),
  );
  const w = (inner - GAP * (cols - 1)) / cols;
  const groups = scene.tileGroups?.length
    ? scene.tileGroups
    : [{ id: "", label: "", summary: undefined as string | undefined }];
  let y = 6;
  let order = 0;
  for (const group of groups) {
    const members = tiles.filter((tile) => (tile.group ?? "") === group.id);
    if (!members.length) continue;
    if (group.label) {
      out.labels.push({
        id: `g:${group.id}`,
        x: PAD,
        y: y + 15,
        z: 0,
        text: fit(group.label, inner * 0.6, "md", true),
        anchor: "start",
        tone: "text",
        size: "md",
        bold: true,
      });
      if (group.summary)
        out.labels.push({
          id: `gs:${group.id}`,
          x: width - PAD,
          y: y + 15,
          z: 0,
          text: fit(group.summary, inner * 0.4, "xs"),
          anchor: "end",
          tone: "dim",
          size: "xs",
        });
      out.lines.push({
        id: `gl:${group.id}`,
        kind: "grid",
        pts: [
          [PAD, y + 23],
          [width - PAD, y + 23],
        ],
        z: -6,
        tone: "muted",
        width: 1,
      });
      y += 32;
    }
    members.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = PAD + col * (w + GAP);
      const ty = y + row * (TILE_H + GAP);
      const tone = toneOf(tile.status);
      out.shapes.push({
        id: `tile:${tile.id}`,
        type: "box",
        tone,
        style:
          tile.status === "unknown"
            ? "dashed"
            : tile.status === "off"
              ? "ghost"
              : "solid",
        tip: `${tile.label}: ${tile.state}${tile.detail ? ` (${tile.detail})` : ""}`,
        x,
        y: ty,
        w,
        h: TILE_H,
        d: relief(tile),
        z: 0,
        appear: Math.min(0.9, order++ * 0.015),
      });
      out.glyphs.push({
        id: `m:${tile.id}`,
        x: x + 16,
        y: ty + 20,
        z: relief(tile),
        size: 16,
        glyph: markFor(tile.status),
        tone,
        title: tile.state,
      });
      out.labels.push({
        id: `l:${tile.id}`,
        x: x + 31,
        y: ty + 25,
        z: relief(tile),
        text: fit(tile.label, w - 40, "sm", true),
        anchor: "start",
        tone: "text",
        size: "sm",
        bold: true,
      });
      out.labels.push({
        id: `s:${tile.id}`,
        x: x + 12,
        y: ty + 45,
        z: relief(tile),
        text: fit(tile.state, w - 20, "md", true),
        anchor: "start",
        tone,
        size: "md",
        bold: true,
      });
      if (tile.detail)
        out.labels.push({
          id: `d:${tile.id}`,
          x: x + 12,
          y: ty + 60,
          z: relief(tile),
          text: fit(tile.detail, w - 20, "xs"),
          anchor: "start",
          tone: "dim",
          size: "xs",
        });
    });
    y += Math.ceil(members.length / cols) * (TILE_H + GAP) + 6;
  }
  out.height = Math.max(60, y);
  const present = new Set(tiles.map((tile) => tile.status));
  out.legend = (
    ["ok", "active", "warning", "critical", "off", "unknown"] as const
  )
    .filter((status) => present.has(status))
    .map((status) => ({
      tone: status,
      label: {
        ok: "In orde",
        active: "Actief",
        warning: "Let op",
        critical: "Probleem",
        off: "Uit",
        unknown: "Onbekend",
      }[status],
    }));
  return finish(out);
}
