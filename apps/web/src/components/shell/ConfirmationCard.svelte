<script lang="ts">
  import { onMount } from "svelte";
  import { answerCard, type Card } from "#lib/chat/cards.svelte.ts";
  import { getConversationLanguage } from "#lib/chat/session.ts";

  let { card }: { card: Card } = $props();
  let language = $state(getConversationLanguage());
  onMount(() => {
    const update = () => (language = getConversationLanguage());
    window.addEventListener("nova-conversation-language-changed", update);
    return () =>
      window.removeEventListener("nova-conversation-language-changed", update);
  });
</script>

<div class="confirmation-controls dock-card" class:done={card.done}>
  <span>{card.label}</span>
  <button
    type="button"
    class="btn go"
    disabled={card.locked}
    onclick={() => answerCard(card.id, true)}
    >{card.tool === "code_file_write"
      ? language === "en"
        ? "Apply"
        : "Toepassen"
      : card.tool === "code_self_save"
        ? language === "en"
          ? "Save"
          : "Opslaan"
        : language === "en"
          ? "Confirm"
          : "Bevestigen"}</button
  >
  <button
    type="button"
    class="btn"
    disabled={card.locked}
    onclick={() => answerCard(card.id, false)}
    >{language === "en" ? "Cancel" : "Annuleren"}</button
  >
  {#if !card.done}
    <div class="ttl" style:--ttl="{card.ttl}ms"></div>
  {/if}
</div>
