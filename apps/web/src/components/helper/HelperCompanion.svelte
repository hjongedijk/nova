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
  }: {
    state?: string;
    compact?: boolean;
  } = $props();
  let stage: HTMLDivElement;
  let avatar: OrbHandle | undefined;

  function currentState(): UiState {
    if (mood === "idle" || mood === "ready") return "ready";
    if (mood === "listening" || mood === "thinking" || mood === "speaking")
      return mood;
    return chat.uiState;
  }
  onMount(() => {
    let visible = false,
      disposed = false;
    function mountOrb() {
      const canvas = document.createElement("canvas");
      canvas.className = "companion-helmet";
      canvas.dataset.renderer = "orb";
      // eslint-disable-next-line svelte/no-dom-manipulating -- This empty mount has no Svelte children; the renderer owns its canvases.
      stage.replaceChildren(canvas);
      avatar = startOrb({
        canvas,
        state: currentState,
        shape: () => helper.shape,
        hue: helperHue,
        night: () => cueQuiet(helper.cues),
        intensity: () => chat.confirmations.length + attentionCount(),
      });
    }
    function updateVisibility() {
      if (!visible || document.hidden || disposed) {
        avatar?.stop();
        avatar = undefined;
        // eslint-disable-next-line svelte/no-dom-manipulating -- The renderer owns this empty mount's canvases.
        stage.replaceChildren();
        return;
      }
      if (!avatar) mountOrb();
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      updateVisibility();
    });
    observer.observe(stage);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      avatar?.stop();
      avatar = undefined;
    };
  });
  $effect(() => {
    void helper.eventId;
    avatar?.trigger(helper.event);
  });
  $effect(() => {
    if (mood === "error") avatar?.trigger("error");
  });
</script>

<div
  class="nova-companion"
  class:compact
  data-state={mood}
  aria-hidden="true"
  bind:this={stage}
></div>

<style>
  .nova-companion {
    flex: none;
    width: 160px;
    height: 136px;
    max-width: 100%;
    pointer-events: none;
  }
  .nova-companion :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
  .compact {
    width: 32px;
    height: 30px;
  }
</style>
