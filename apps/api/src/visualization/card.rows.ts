import type { VizScene } from "@nova/contracts";

/** The data of a card scene as table rows (header first), for CSV export. */
export function cardRows(scene: VizScene): unknown[][] {
  switch (scene.kind) {
    case "weather": {
      const weather = scene.weather;
      return [
        ["soort", "moment", "temperatuur of min/max", "regen", "weer"],
        ...(weather?.hours ?? []).map((hour) => [
          "uur",
          hour.label,
          hour.temperature,
          hour.rainPercent === null ? null : `${hour.rainPercent}%`,
          hour.condition,
        ]),
        ...(weather?.days ?? []).map((day) => [
          "dag",
          day.label,
          `${day.min ?? ""}/${day.max ?? ""}`,
          day.rainMm === null ? null : `${day.rainMm} mm`,
          day.condition,
        ]),
      ];
    }
    case "gauges":
      return [
        ["meter", "waarde", "eenheid", "max", "status"],
        ...(scene.gauges ?? []).map((gauge) => [
          gauge.label,
          gauge.value,
          gauge.unit,
          gauge.max,
          gauge.status,
        ]),
      ];
    case "timeline":
      return [
        ["soort", "titel", "begin", "einde"],
        ...(scene.timeline?.items ?? []).map((item) => [
          item.kind,
          item.label,
          item.start,
          item.end,
        ]),
      ];
    case "tiles":
      return [
        ["groep", "naam", "toestand", "status"],
        ...(scene.tiles ?? []).map((tile) => [
          tile.group,
          tile.label,
          tile.state,
          tile.status,
        ]),
      ];
    default:
      return [
        ["reeks", "label", "waarde", "eenheid"],
        ...(scene.chart?.series ?? []).flatMap((series) =>
          series.points.map((point) => [
            series.label,
            point.label,
            point.value,
            scene.chart?.unit,
          ]),
        ),
      ];
  }
}
