<script lang="ts">
  import { onMount } from "svelte";
  import { wallpaper } from "#lib/modes/wallpaper.ts";
  import { startEntity } from "#lib/entity/entity.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { lightSync, startLightSync } from "#lib/stores/light-sync.svelte.ts";

  let canvas: HTMLCanvasElement;
  let core: HTMLButtonElement;

  onMount(() => {
    const stopLightSync = startLightSync();
    const stopEntity = startEntity({
      canvas,
      wallpaper,
      state: () => chat.uiState,
      // An open confirmation card or an open warning turns the sphere red and makes it beat.
      intensity: () => chat.confirmations.length + attentionCount(),
      hue: () => (lightSync.enabled ? lightSync.hue : null),
      core: () => core,
      stage: () => document.querySelector<HTMLElement>(".stage"),
    });
    return () => {
      stopEntity();
      stopLightSync();
    };
  });
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
