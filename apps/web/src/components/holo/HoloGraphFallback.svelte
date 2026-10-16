<script lang="ts">
  import { layoutGraph } from "#lib/holo/layout.ts";
  import { statusColor, STATUS_LABELS } from "#lib/holo/colors.ts";
  import type { VizScene } from "#lib/holo/types.ts";

  /** Flat SVG drawing of a graph for browsers without WebGL; same layout, same colours. */
  let {
    scene,
    theme = "dark",
    selected = null,
    onselect,
  }: {
    scene: VizScene;
    theme?: "dark" | "light";
    selected?: string | null;
    onselect?: (id: string | null) => void;
  } = $props();

  const layout = $derived(layoutGraph(scene));
  const pad = 40;
  const extent = $derived(layout.radius * 26 + pad);
  const at = (id: string) => {
    const place = layout.places.get(id);
    return place ? { x: place.u * 26, y: place.v * 26 } : { x: 0, y: 0 };
  };
</script>

<svg
  class="graph"
  data-holo-fallback
  viewBox="{-extent} {-extent} {extent * 2} {extent * 2}"
  role="group"
  aria-label="{scene.title}: vlakke weergave"
>
  {#each scene.edges ?? [] as edge (`${edge.from}>${edge.to}`)}
    {@const a = at(edge.from)}
    {@const b = at(edge.to)}
    <line
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      class:bad={edge.status === "critical"}
    />
  {/each}
  {#each scene.nodes ?? [] as node (node.id)}
    {@const p = at(node.id)}
    {@const color = statusColor(node.status, theme)}
    {@const r = 7 + (node.size ?? 1) * 5}
    <g
      transform="translate({p.x} {p.y})"
      role="button"
      tabindex="0"
      aria-label="{node.label}: {STATUS_LABELS[node.status ?? 'unknown']}"
      aria-pressed={selected === node.id}
      onclick={() => onselect?.(selected === node.id ? null : node.id)}
      onkeydown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onselect?.(selected === node.id ? null : node.id);
        }
      }}
    >
      <circle
        {r}
        fill={node.status === "unknown" ? "none" : color}
        fill-opacity={node.status === "off" ? 0.3 : 0.55}
        stroke={color}
        stroke-width={selected === node.id ? 3 : 1.5}
        stroke-dasharray={node.status === "unknown" ? "3 3" : undefined}
      />
      <text y={r + 12} text-anchor="middle">{node.label}</text>
    </g>
  {/each}
</svg>

<style>
  .graph {
    width: 100%;
    height: 100%;
    display: block;
  }
  line {
    stroke: var(--dim);
    stroke-width: 1;
    opacity: 0.5;
  }
  line.bad {
    stroke: var(--alert);
    opacity: 0.9;
  }
  g {
    cursor: pointer;
    outline: none;
  }
  g:focus-visible circle {
    stroke-width: 3;
    stroke: var(--mist);
  }
  text {
    fill: var(--mist);
    font: 500 10px var(--sans);
  }
</style>
