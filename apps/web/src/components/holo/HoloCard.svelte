<script lang="ts">
  import { onMount } from "svelte";
  import type { Card3D } from "#lib/holo/card3d.ts";
  import { layoutCard } from "#lib/holo/card/index.ts";
  import { toneColor } from "#lib/holo/card/colors.ts";
  import { GLYPHS } from "#lib/holo/card/glyphs.ts";
  import { arcPath, areaPath, linePath } from "#lib/holo/card/paths.ts";
  import {
    FLAT_REASON_TEXT,
    claim3d,
    flatReason,
    hasWebgl,
    readPowerHints,
    release3d,
    type FlatReason,
  } from "#lib/holo/card/power.ts";
  import { FONT_PX, type CardShape } from "#lib/holo/card/types.ts";
  import type { VizScene } from "#lib/holo/types.ts";
  import HoloTable from "./HoloTable.svelte";

  /**
   * A holographic card: weather, gauges, timeline, tiles or a 3D bar/area chart. It is a complete
   * flat SVG first (that is also the fallback for reduced motion, low power and no WebGL), and
   * becomes a shallow 3D hologram once it is visible and the lazy three.js chunk has loaded.
   */
  let {
    scene,
    theme = "dark",
    flat = false,
    onexpand,
    large = false,
  }: {
    scene: VizScene;
    theme?: "dark" | "light";
    /** Stay flat (history list: no extra GPU context). */
    flat?: boolean;
    /** Shows the "Uitvergroten" button. */
    onexpand?: () => void;
    /** In the big panel: more height, notes visible. */
    large?: boolean;
  } = $props();

  let box: HTMLElement | undefined = $state();
  let glHost: HTMLElement | undefined = $state();
  let width = $state(0);
  let visible = $state(false);
  let engine = $state.raw<Card3D | null>(null);
  let claimed = false;
  let creating = false;
  let destroyed = false;
  let introPlayed = false;
  /** The 3D picture has drawn its first frame; until then the flat one stays. */
  let live = $state(false);
  let reason = $state<FlatReason | null>(null);
  let userWants3d = $state<boolean | null>(null);
  let hintsReady = $state(false);
  let showTable = $state(false);
  let proj = $state.raw<Float32Array | null>(null);
  let tip = $state<{ text: string; x: number; y: number } | null>(null);
  let failed = $state(false);

  const estimate = $derived(layoutCard(scene, 360).height);
  const layout = $derived(width ? layoutCard(scene, width) : null);
  const want3d = $derived(
    !flat && !failed && hintsReady && (userWants3d ?? reason === null),
  );
  const anchors = $derived(
    layout
      ? [...layout.labels, ...layout.glyphs].map((a) => ({
          x: a.x,
          y: a.y,
          z: a.z,
        }))
      : [],
  );
  const canToggle = $derived(
    !flat && hintsReady && reason !== "no-webgl" && !failed,
  );
  const summary = $derived(scene.summary ?? scene.title);
  const flatNote = $derived(
    flat || !hintsReady || live || !reason ? "" : FLAT_REASON_TEXT[reason],
  );
  const color = (tone: Parameters<typeof toneColor>[0]) =>
    toneColor(tone, theme);

  function fill(shape: CardShape): {
    fill: string;
    opacity: number;
    dash?: string;
  } {
    const base =
      shape.style === "dashed" ? 0 : shape.style === "ghost" ? 0.1 : 0.3;
    return {
      fill: color(shape.tone),
      opacity: theme === "light" ? base * 1.6 : base,
      ...(shape.style === "dashed" ? { dash: "4 3" } : {}),
    };
  }
  const labelX = (i: number, x: number) => (live && proj ? proj[i * 2]! : x);
  const labelY = (i: number, y: number) =>
    live && proj ? proj[i * 2 + 1]! : y;

  function showTip(event: PointerEvent): void {
    const target = (event.target as Element | null)?.closest("[data-tip]");
    if (!target || !box) {
      tip = null;
      return;
    }
    const rect = box.getBoundingClientRect();
    tip = {
      text: target.getAttribute("data-tip") ?? "",
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  // Layout width: measured before the first paint, then followed.
  onMount(() => {
    if (!box) return;
    width = box.clientWidth;
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (box && Math.abs(box.clientWidth - width) >= 2)
          width = box.clientWidth;
      });
    });
    resize.observe(box);
    let seen: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "function") {
      seen = new IntersectionObserver((entries) => {
        visible =
          entries.some((entry) => entry.isIntersecting) && !document.hidden;
      });
      seen.observe(box);
    } else visible = true;
    const onVisibility = () => {
      if (document.hidden) visible = false;
    };
    document.addEventListener("visibilitychange", onVisibility);
    void readPowerHints().then((hints) => {
      reason = flatReason(hints);
      hintsReady = true;
    });
    return () => {
      destroyed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      seen?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      stop3d();
    };
  });

  function stop3d(): void {
    engine?.dispose();
    engine = null;
    if (claimed) release3d();
    claimed = false;
    live = false;
    proj = null;
  }

  // Lazy 3D: only for a visible card that may use it; one chunk, one context per card.
  $effect(() => {
    if (!want3d || !visible || engine || creating || !glHost || !layout) return;
    const host = glHost;
    if (!claim3d()) return;
    claimed = true;
    creating = true;
    void import("#lib/holo/card3d.ts")
      .then(({ Card3D }) => {
        if (destroyed || !box) return stop3d();
        engine = new Card3D({
          host,
          theme,
          reducedMotion:
            typeof matchMedia === "function" &&
            matchMedia("(prefers-reduced-motion: reduce)").matches,
          onproject: (positions) => {
            proj = positions;
            if (!live) live = true;
          },
          onhover: (id, x, y) => {
            const shape = layout?.shapes.find((item) => item.id === id);
            tip = shape ? { text: shape.tip, x, y } : null;
          },
          onlost: () => {
            failed = true;
            stop3d();
          },
        });
      })
      .catch(() => {
        failed = true;
        stop3d();
      })
      .finally(() => {
        creating = false;
      });
  });

  // Follow data and size changes.
  $effect(() => {
    if (!engine || !layout) return;
    engine.resize(layout.width, layout.height);
    engine.setLayout(layout, anchors, !introPlayed);
    introPlayed = true;
  });
  $effect(() => {
    engine?.setTheme(theme);
  });
  $effect(() => {
    engine?.setVisible(visible);
  });
  // The user turned 3D off, or the card must stay flat.
  $effect(() => {
    if (!want3d && engine) stop3d();
  });

  function toggle3d(): void {
    if (!want3d && !hasWebgl()) {
      failed = true;
      return;
    }
    userWants3d = !want3d;
  }
</script>

<figure
  class="card"
  class:large
  data-holo-card
  data-kind={scene.kind}
  data-render={live ? "3d" : "flat"}
  data-theme={theme}
  aria-label={scene.title}
>
  <figcaption>
    <h3 class:gone={large}>{scene.title}</h3>
    <div class="acts">
      {#if canToggle}
        <button
          type="button"
          class="act"
          aria-pressed={want3d}
          title={flatNote ||
            "Wissel tussen de 3D-weergave en de vlakke weergave"}
          onclick={toggle3d}>{want3d ? "Vlak" : "3D"}</button
        >
      {/if}
      <button
        type="button"
        class="act"
        aria-expanded={showTable}
        onclick={() => (showTable = !showTable)}>Tabel</button
      >
      {#if onexpand}
        <button type="button" class="act primary" onclick={onexpand}
          >Uitvergroten</button
        >
      {/if}
    </div>
  </figcaption>

  <div
    class="visual"
    class:hidden={showTable}
    bind:this={box}
    style:min-height="{layout ? layout.height : estimate}px"
    role="img"
    aria-label={summary}
  >
    {#if layout}
      <div class="gl" bind:this={glHost}></div>
      <svg
        class="plane"
        class:off={live}
        width={layout.width}
        height={layout.height}
        viewBox="0 0 {layout.width} {layout.height}"
        aria-hidden="true"
        onpointermove={showTip}
        onpointerdown={showTip}
        onpointerleave={() => (tip = null)}
      >
        {#each layout.lines as line (line.id)}
          <path
            class="line {line.kind}"
            d={linePath(line.pts)}
            stroke={color(line.tone)}
            stroke-width={line.width}
            stroke-dasharray={line.dashed ? "5 4" : undefined}
            fill="none"
          />
        {/each}
        {#each layout.shapes as shape (shape.id)}
          {@const paint = fill(shape)}
          {#if shape.type === "box"}
            <rect
              data-tip={shape.tip}
              x={shape.x}
              y={shape.y}
              width={shape.w}
              height={shape.h}
              rx="2"
              fill={paint.fill}
              fill-opacity={paint.opacity}
              stroke={paint.fill}
              stroke-width="1.4"
              stroke-opacity={shape.style === "ghost" ? 0.5 : 0.95}
              stroke-dasharray={paint.dash}
            />
          {:else}
            <path
              data-tip={shape.tip}
              d={shape.type === "arc" ? arcPath(shape) : areaPath(shape)}
              fill={paint.fill}
              fill-opacity={paint.opacity}
              stroke={paint.fill}
              stroke-width="1.4"
              stroke-opacity={shape.style === "ghost" ? 0.5 : 0.95}
              stroke-dasharray={paint.dash}
            />
          {/if}
        {/each}
      </svg>
      <svg
        class="over"
        width={layout.width}
        height={layout.height}
        viewBox="0 0 {layout.width} {layout.height}"
        aria-hidden="true"
        onpointermove={showTip}
        onpointerdown={showTip}
        onpointerleave={() => (tip = null)}
      >
        {#each layout.glyphs as glyph, g (glyph.id)}
          {@const i = layout.labels.length + g}
          {@const def = GLYPHS[glyph.glyph]}
          <g
            class="glyph"
            transform="translate({labelX(i, glyph.x) - glyph.size / 2} {labelY(
              i,
              glyph.y,
            ) -
              glyph.size / 2}) scale({glyph.size / 24})"
            color={color(glyph.tone)}
            data-tip={glyph.title}
          >
            {#each def.paths as d, k (k)}
              <path
                {d}
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            {/each}
            {#each def.fills ?? [] as d, k (k)}
              <path
                {d}
                fill="currentColor"
                stroke="currentColor"
                stroke-width="1.2"
              />
            {/each}
          </g>
        {/each}
        {#each layout.labels as label, i (label.id)}
          <text
            class="lab"
            class:bold={label.bold}
            x={labelX(i, label.x)}
            y={labelY(i, label.y)}
            text-anchor={label.anchor}
            font-size={FONT_PX[label.size]}
            fill={color(label.tone)}>{label.text}</text
          >
        {/each}
      </svg>
      <div class="scan" aria-hidden="true"></div>
      {#if tip}
        <div
          class="tip"
          role="tooltip"
          style:left="{Math.min(
            Math.max(tip.x, 70),
            Math.max(70, layout.width - 70),
          )}px"
          style:top="{Math.max(tip.y - 14, 18)}px"
        >
          {tip.text}
        </div>
      {/if}
    {/if}
  </div>

  {#if showTable}
    <div class="table"><HoloTable {scene} /></div>
  {/if}

  {#if layout?.legend.length && !showTable}
    <ul class="legend" aria-label="Legenda">
      {#each layout.legend as item (item.label)}
        <li><i style:background={color(item.tone)}></i>{item.label}</li>
      {/each}
    </ul>
  {/if}
  <p class="sr">{summary}</p>
</figure>

<style>
  .card {
    --halo: rgba(6, 12, 28, 0.92);
    position: relative;
    margin: 0;
    padding: 10px 12px 12px;
    border: 1px solid color-mix(in srgb, var(--glow, #6ddcf5) 34%, transparent);
    border-radius: 6px;
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--glow, #6ddcf5) 7%, transparent),
        transparent 46%
      ),
      rgba(7, 13, 28, 0.78);
    box-shadow:
      0 0 0 1px rgba(109, 220, 245, 0.06) inset,
      0 0 26px rgba(109, 220, 245, 0.09);
    color: var(--mist, #e9e6f5);
    text-align: left;
    font-family: var(--sans, system-ui, sans-serif);
  }
  .card[data-theme="light"] {
    --halo: rgba(255, 255, 255, 0.92);
    background: rgba(246, 249, 255, 0.92);
    color: #14182b;
  }
  .card::before,
  .card::after {
    content: "";
    position: absolute;
    width: 14px;
    height: 14px;
    border: 2px solid var(--glow, #6ddcf5);
    pointer-events: none;
    opacity: 0.85;
  }
  .card::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .card::after {
    right: -1px;
    bottom: -1px;
    border-left: 0;
    border-top: 0;
  }
  figcaption {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin-bottom: 8px;
  }
  h3 {
    margin: 0 auto 0 0;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
  }
  h3.gone {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .acts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .act {
    min-height: 32px;
    padding: 4px 11px;
    border: 1px solid color-mix(in srgb, var(--glow, #6ddcf5) 40%, transparent);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: 600 12.5px var(--sans, system-ui, sans-serif);
    cursor: pointer;
  }
  .act:hover,
  .act[aria-pressed="true"],
  .act[aria-expanded="true"] {
    background: color-mix(in srgb, var(--glow, #6ddcf5) 16%, transparent);
  }
  .act.primary {
    border-color: var(--glow, #6ddcf5);
    color: var(--glow, #6ddcf5);
  }
  .act:focus-visible {
    outline: 2px solid var(--glow, #6ddcf5);
    outline-offset: 2px;
  }
  @media (pointer: coarse) {
    .act {
      min-height: 40px;
    }
  }
  .visual {
    position: relative;
    width: 100%;
    overflow: hidden;
  }
  .visual.hidden {
    display: none;
  }
  .gl,
  .plane,
  .over,
  .scan {
    position: absolute;
    inset: 0;
  }
  .gl {
    pointer-events: auto;
  }
  .plane {
    pointer-events: auto;
    transition: opacity 0.35s;
  }
  .plane.off {
    opacity: 0;
    pointer-events: none;
  }
  .over {
    pointer-events: none;
  }
  [data-render="flat"] .over .glyph {
    pointer-events: auto;
  }
  .scan {
    pointer-events: none;
    background: repeating-linear-gradient(
      0deg,
      transparent 0 2px,
      rgba(109, 220, 245, 0.045) 2px 3px
    );
    mix-blend-mode: screen;
  }
  [data-theme="light"] .scan {
    display: none;
  }
  .lab {
    font-family: var(--sans, system-ui, sans-serif);
    font-variant-numeric: tabular-nums;
    paint-order: stroke;
    stroke: var(--halo);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .lab.bold {
    font-weight: 700;
  }
  .line.curve,
  .plane :global(path[data-tip]) {
    filter: drop-shadow(0 0 3px currentColor);
  }
  .line.grid {
    opacity: 0.22;
  }
  .line.axis {
    opacity: 0.6;
  }
  .tip {
    position: absolute;
    transform: translate(-50%, -100%);
    max-width: 260px;
    padding: 5px 9px;
    border: 1px solid var(--glow, #6ddcf5);
    border-radius: 3px;
    background: rgba(5, 10, 22, 0.96);
    color: #f1f4ff;
    font-size: 12.5px;
    line-height: 1.35;
    pointer-events: none;
    z-index: 3;
  }
  .legend,
  .notes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--dim, #aab3d2);
  }
  .notes {
    display: block;
    padding-left: 16px;
    list-style: disc;
    line-height: 1.5;
  }
  .legend i {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    border-radius: 2px;
  }
  .table {
    max-height: 340px;
    overflow: auto;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .large .visual {
    margin: 0 auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .plane {
      transition: none;
    }
  }
</style>
