<script lang="ts">
  import { statusColor, STATUS_LABELS } from "#lib/holo/colors.ts";
  import type { VizScene } from "#lib/holo/types.ts";

  let { scene, theme = "dark" }: { scene: VizScene; theme?: "dark" | "light" } =
    $props();

  const chart = $derived(scene.chart);
  const labels = $derived(
    chart
      ? [...new Set(chart.series.flatMap((s) => s.points.map((p) => p.label)))]
      : [],
  );
  const max = $derived(
    chart
      ? (chart.max ??
          Math.max(
            1,
            ...chart.series.flatMap((s) => s.points.map((p) => p.value ?? 0)),
          ))
      : 1,
  );
  const colorOf = (status: string | undefined) =>
    statusColor(status as never, theme);
  const valueText = (value: number | null) =>
    value === null
      ? "onbekend"
      : `${new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(value)} ${chart?.unit ?? ""}`;
  const pointOf = (series: number, label: string) =>
    chart?.series[series]?.points.find((p) => p.label === label);
  const summary = $derived(
    `${scene.title}: ${labels.length} onderdelen, ${chart?.series.map((s) => s.label).join(" en ")} in ${chart?.unit}.`,
  );
</script>

{#if chart}
  <div class="chart" data-holo-chart>
    <svg
      role="img"
      aria-label={summary}
      viewBox="0 0 640 {labels.length * (chart.series.length * 16 + 12) + 8}"
      preserveAspectRatio="xMinYMin meet"
    >
      {#each labels as label, row (label)}
        {@const top = row * (chart.series.length * 16 + 12) + 4}
        <text class="lab" x="0" y={top + 11}>{label}</text>
        {#each chart.series as series, s (series.label)}
          {@const point = pointOf(s, label)}
          <g transform="translate(150 {top + s * 16})">
            {#if point && point.value !== null}
              <rect
                class="bar"
                width={Math.max(2, (point.value / max) * 380)}
                height="12"
                rx="1"
                fill={colorOf(point.status)}
                opacity={s ? 0.55 : 1}
                data-status={point.status ?? "unknown"}
              >
                <title
                  >{series.label} · {label}: {valueText(point.value)} ({STATUS_LABELS[
                    point.status ?? "unknown"
                  ]})</title
                >
              </rect>
              <text
                class="val"
                x={Math.max(2, (point.value / max) * 380) + 6}
                y="10">{valueText(point.value)}</text
              >
            {:else}
              <rect class="none" width="380" height="12" rx="1" />
              <text class="val" x="6" y="10">onbekend</text>
            {/if}
          </g>
        {/each}
      {/each}
    </svg>
    <ul class="legend">
      {#each chart.series as series, s (series.label)}
        <li>
          <i
            style:background={statusColor("active", theme)}
            style:opacity={s ? 0.45 : 1}
          ></i>{series.label}
        </li>
      {/each}
      <li class="hint">De kleur van een balk toont de status.</li>
    </ul>
  </div>
{/if}

<style>
  .chart {
    height: 100%;
    overflow: auto;
    padding: 12px 16px 16px;
  }
  svg {
    width: 100%;
    max-width: 760px;
    display: block;
  }
  .lab {
    fill: var(--mist);
    font: 600 11px var(--sans);
  }
  .val {
    fill: var(--dim);
    font: 500 10px var(--sans);
  }
  .none {
    fill: none;
    stroke: var(--dim);
    stroke-dasharray: 3 3;
    opacity: 0.6;
  }
  .legend {
    display: flex;
    gap: 16px;
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    color: var(--dim);
    font-size: 12px;
  }
  .legend i {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    border-radius: 1px;
  }
</style>
