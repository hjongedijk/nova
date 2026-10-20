<script lang="ts">
  import { onMount, untrack } from "svelte";
  import HelperCompanion from "#components/helper/HelperCompanion.svelte";
  import { helper } from "#lib/stores/helper.svelte.ts";
  import { wallpaper } from "#lib/modes/wallpaper.ts";
  import { startEntity } from "#lib/entity/entity.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { lightSync, startLightSync } from "#lib/stores/light-sync.svelte.ts";

  let canvas = $state<HTMLCanvasElement>();
  let core = $state<HTMLButtonElement>();
  const showFace = $derived(helper.avatar === "face");

  onMount(() => {
    return startLightSync();
  });
  $effect(() => {
    if (showFace || !canvas || !core) return;
    const target = canvas;
    return untrack(() =>
      startEntity({
        canvas: target,
        wallpaper,
        state: () => chat.uiState,
        // An open confirmation card or an open warning turns the sphere red and makes it beat.
        intensity: () => chat.confirmations.length + attentionCount(),
        hue: () => (lightSync.enabled ? lightSync.hue : null),
        core: () => core ?? null,
        stage: () => document.querySelector<HTMLElement>(".stage"),
      }),
    );
  });
</script>

<canvas
  id="entity"
  bind:this={canvas}
  aria-hidden="true"
  style:visibility={showFace ? "hidden" : undefined}
></canvas>
{#if showFace}
  <div class="wallpaper-portrait">
    <HelperCompanion state={chat.uiState} large panoramic />
  </div>
{/if}

<button
  id="core"
  type="button"
  aria-label="Spreken of spraak stoppen"
  title="Tik om te spreken"
  bind:this={core}
  style={showFace
    ? "left:50%;top:37%;width:min(42vmin,420px);height:min(55vmin,520px);transform:translate(-50%,-50%)"
    : undefined}
  onclick={pressCore}
></button>

<style>
  .wallpaper-portrait {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 100vw;
    height: 100vh;
    pointer-events: none;
  }
</style>
