<script lang="ts">
  import { cards } from "#lib/chat/cards.svelte.ts";
  import ConfirmationCard from "./ConfirmationCard.svelte";
</script>

<div id="dock">
  {#each cards as card (card.id)}
    <ConfirmationCard {card} />
  {/each}
</div>
