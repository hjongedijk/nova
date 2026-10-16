<script lang="ts">
  import { expandInline, holo } from "#lib/holo/store.svelte.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import HoloCard from "./HoloCard.svelte";

  /**
   * The hologram under NOVA's answer: built by the server from the tool results of this turn, so
   * it only exists when real data arrived. It stays while the answer is on the stage.
   */
  const scene = $derived(
    holo.inline && (chat.you || chat.reply) ? holo.inline : null,
  );
</script>

{#if scene}
  {#key scene.id}
    <div class="inline" data-holo-inline>
      <HoloCard {scene} onexpand={() => expandInline(scene)} />
    </div>
  {/key}
{/if}

<style>
  .inline {
    width: min(620px, 100%);
    text-align: left;
    animation: arrive 0.4s ease-out both;
  }
  /* The answer above the card gets less height, so both fit on a phone. */
  :global(#reply.with-card) {
    max-height: 22vh;
  }
  @keyframes arrive {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .inline {
      animation: none;
    }
  }
</style>
