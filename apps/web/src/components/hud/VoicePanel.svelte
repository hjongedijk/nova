<script lang="ts">
  import { onMount } from "svelte";
  import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { drawEq, glowHsl, prepareCanvas } from "#lib/util/charts.ts";

  let eq: HTMLCanvasElement;

  const reduceMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  onMount(() => {
    let ctx = prepareCanvas(eq, 212, 40);
    const resize = () => (ctx = prepareCanvas(eq, 212, 40));
    window.addEventListener("resize", resize);
    let frame = 0;
    const draw = (ms: number) => {
      if (window.innerWidth >= 1340 && eq.offsetParent && ctx)
        drawEq(ctx, glowHsl(), audioLevel, ms / 1000, reduceMotion ? 0.35 : 1);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  });
</script>

<section class="hud" data-panel="stem" aria-label="Stem">
  <h2>
    Stem <em id="latency"
      >{chat.latency != null ? `${chat.latency.toFixed(1)} s` : "–"}</em
    >
  </h2>
  <canvas id="eq" bind:this={eq} aria-hidden="true"></canvas>
</section>
