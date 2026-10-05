<script lang="ts">
  import { onMount } from "svelte";
  import { startEntity } from "#lib/entity/entity.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";

  let canvas: HTMLCanvasElement;
  let core: HTMLButtonElement;

  onMount(() =>
    startEntity({
      canvas,
      state: () => chat.uiState,
      // An open confirmation card or an open warning turns the sphere red and makes it beat.
      intensity: () => chat.confirmations.length + attentionCount(),
      core: () => core,
      stage: () => document.querySelector<HTMLElement>(".stage"),
    }),
  );
</script>

<canvas id="entity" bind:this={canvas} aria-hidden="true"></canvas>

<button
  id="core"
  type="button"
  aria-label="Spreken of spraak stoppen"
  title="Tik om te spreken"
  bind:this={core}
  onclick={pressCore}
></button>
