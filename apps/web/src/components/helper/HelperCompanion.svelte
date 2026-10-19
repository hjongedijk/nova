<script lang="ts">
  import { onMount } from "svelte";
  import { startOrb, type OrbHandle } from "#lib/entity/orb.ts";
  import { helper, helperHue } from "#lib/stores/helper.svelte.ts";
  import { chat, type UiState } from "#lib/stores/chat.svelte.ts";
  import { attentionCount } from "#lib/stores/toasts.svelte.ts";
  import { cueQuiet } from "#lib/voice/helper-cues.ts";
  let {
    state: mood = "ready",
    compact = false,
  }: { state?: string; compact?: boolean } = $props();
  let canvas: HTMLCanvasElement;
  let orb: OrbHandle | undefined;

  function currentState(): UiState {
    if (mood === "idle" || mood === "ready") return "ready";
    if (mood === "listening" || mood === "thinking" || mood === "speaking")
      return mood;
    return chat.uiState;
  }

  onMount(() => {
    let visible = false;
    function updateVisibility() {
      if (visible && !document.hidden) {
        orb ??= startOrb({
          canvas,
          portrait: true,
          state: currentState,
          shape: () => helper.shape,
          hue: helperHue,
          night: () => cueQuiet(helper.cues),
          intensity: () => chat.confirmations.length + attentionCount(),
          // The existing helper orb owns sound cues. This is the same visual
          // renderer, without broadcasting a second copy of its reactions.
        });
      } else {
        orb?.stop();
        orb = undefined;
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      updateVisibility();
    });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      orb?.stop();
      orb = undefined;
    };
  });

  $effect(() => {
    void helper.eventId;
    orb?.trigger(helper.event);
  });
  $effect(() => {
    if (mood === "error") orb?.trigger("error");
  });
</script>

<div class="nova-companion" class:compact data-state={mood} aria-hidden="true">
  <canvas class="companion-helmet" bind:this={canvas}></canvas>
</div>

<style>
  .nova-companion {
    flex: none;
    width: 144px;
    height: 124px;
    max-width: 100%;
    pointer-events: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .compact {
    width: 32px;
    height: 30px;
  }
</style>
