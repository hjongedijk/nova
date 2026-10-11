<script lang="ts">
  import { answerCard, type Card } from "#lib/chat/cards.svelte.ts";

  let { card }: { card: Card } = $props();
</script>

<div class="confirmation-controls dock-card" class:done={card.done}>
  <span>{card.label}</span>
  <button
    type="button"
    class="btn go"
    disabled={card.locked}
    onclick={() => answerCard(card.id, true)}
    >{card.tool === "code_file_write"
      ? "Toepassen"
      : card.tool === "code_self_save"
        ? "Opslaan"
        : "Bevestigen"}</button
  >
  <button
    type="button"
    class="btn"
    disabled={card.locked}
    onclick={() => answerCard(card.id, false)}>Annuleren</button
  >
  {#if !card.done}
    <div class="ttl" style:--ttl="{card.ttl}ms"></div>
  {/if}
</div>
