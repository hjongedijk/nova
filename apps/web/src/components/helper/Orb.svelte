<script lang="ts">
  import { onMount } from "svelte";
  import { startOrb, type OrbHandle } from "#lib/entity/orb.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";

  let canvas: HTMLCanvasElement;
  let orb: OrbHandle | undefined;

  onMount(() => {
    orb = startOrb({
      canvas,
      state: () => chat.uiState,
      intensity: () => chat.confirmations.length + attentionCount(),
    });
    return () => orb?.stop();
  });

  // A finished turn: a happy hop, or a shake when it went wrong. A new warning also shakes it.
  let wasBusy = false;
  $effect(() => {
    const busy = chat.busy;
    if (wasBusy && !busy)
      orb?.trigger(
        chat.reply.startsWith("Er ging iets mis") ? "error" : "done",
      );
    wasBusy = busy;
  });
  let warnings = 0;
  $effect(() => {
    const now = attentionCount();
    if (now > warnings) orb?.trigger("error");
    warnings = now;
  });
</script>

<canvas class="hp-orb" bind:this={canvas} aria-hidden="true"></canvas>
