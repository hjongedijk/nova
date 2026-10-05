<script lang="ts">
  import { onMount } from "svelte";
  import { startOrb } from "#lib/entity/orb.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";

  let canvas: HTMLCanvasElement;

  onMount(() =>
    startOrb({
      canvas,
      state: () => chat.uiState,
      intensity: () => chat.confirmations.length + attentionCount(),
    }),
  );
</script>

<canvas class="hp-orb" bind:this={canvas} aria-hidden="true"></canvas>
