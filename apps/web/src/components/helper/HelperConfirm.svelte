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

<div class="hc" class:done={card.done}>
  <p>{card.label}</p>
  <div class="hc-row">
    <button
      type="button"
      class="hc-yes"
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
            : "Bevestigen"}
      {#if !card.screenOnly}<kbd aria-hidden="true">Y</kbd>{/if}</button
    >
    <button
      type="button"
      class="hc-no"
      disabled={card.locked}
      onclick={() => answerCard(card.id, false)}
      >{language === "en" ? "Cancel" : "Annuleren"}
      <kbd aria-hidden="true">N</kbd></button
    >
    {#if card.risk === "CONFIRM" && card.allowAlways !== false}
      <button
        type="button"
        class="hc-no"
        disabled={card.locked}
        title={language === "en"
          ? "Always allow this tool with these exact parameters"
          : "Alleen deze tool met exact dezelfde parameters toestaan"}
        onclick={() => answerCard(card.id, true, true)}
        >{language === "en" ? "Always" : "Altijd"}</button
      >
    {/if}
  </div>
  {#if !card.done}
    <div class="hc-ttl" style:--ttl="{card.ttl}ms"></div>
  {/if}
</div>

<style>
  .hc {
    position: relative;
    overflow: hidden;
    padding: 12px 14px 14px;
    border: 1px solid rgba(255, 138, 76, 0.45);
    border-radius: 18px;
    background: linear-gradient(
      180deg,
      rgba(255, 122, 69, 0.16),
      rgba(40, 14, 8, 0.55)
    );
    animation: hc-in 0.25s cubic-bezier(0.3, 1.2, 0.4, 1);
  }
  .hc.done {
    opacity: 0.7;
  }
  p {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.4;
    color: #f5f6f8;
  }
  .hc-row {
    display: flex;
    gap: 8px;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: 600 13px/1 inherit;
    font-family: inherit;
    padding: 0 10px 0 16px;
    min-height: 44px;
    border-radius: 14px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .hc-yes {
    background: #fff;
    color: #111;
  }
  .hc-no {
    background: rgba(255, 255, 255, 0.08);
    color: #f5f6f8;
    border-color: rgba(255, 255, 255, 0.14);
  }
  kbd {
    font: 600 11px/1 inherit;
    font-family: inherit;
    min-width: 22px;
    padding: 5px 7px;
    border-radius: 8px;
    text-align: center;
  }
  .hc-yes kbd {
    background: #e4e5e8;
    color: #444;
  }
  .hc-no kbd {
    background: rgba(255, 255, 255, 0.12);
    color: #b4b8c2;
  }
  .hc-ttl {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: #ff8a4c;
    transform-origin: left;
    animation: hc-ttl var(--ttl, 60s) linear forwards;
  }
  @keyframes hc-ttl {
    to {
      transform: scaleX(0);
    }
  }
  @keyframes hc-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .hc {
      animation: none;
    }
  }
</style>
