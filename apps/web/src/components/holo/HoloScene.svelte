<script lang="ts">
  import { isCardScene } from "#lib/holo/card/index.ts";
  import type { HoloTheme, VizScene } from "#lib/holo/types.ts";
  import HoloCard from "./HoloCard.svelte";
  import HoloViewer from "./HoloViewer.svelte";

  /**
   * Shows any scene: the card kinds (weather, gauges, timeline, tiles, series) as a holographic
   * card, everything else (graph, model, chart) in the universal viewer.
   */
  let { scene, theme = "dark" }: { scene: VizScene; theme?: HoloTheme } =
    $props();
  const dark = $derived<"dark" | "light">(
    theme === "light" ||
      (theme === "auto" &&
        typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: light)").matches)
      ? "light"
      : "dark",
  );
</script>

{#if isCardScene(scene)}
  <div class="cardview"><HoloCard {scene} theme={dark} large /></div>
{:else}
  <HoloViewer {scene} {theme} />
{/if}

<style>
  .cardview {
    height: 100%;
    overflow: auto;
    padding: 16px;
  }
  .cardview > :global(figure) {
    max-width: 880px;
    margin: 0 auto;
  }
  @media (max-width: 640px) {
    .cardview {
      padding: 10px;
    }
  }
</style>
