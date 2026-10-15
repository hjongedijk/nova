<script lang="ts">
  import { chat } from "#lib/stores/chat.svelte.ts";
  import QuickActionsHistory from "#components/settings/QuickActionsHistory.svelte";

  let { separateWindow = false }: { separateWindow?: boolean } = $props();
  let expanded = $state<string | null>(null);
</script>

{#each chat.actionReceipts as receipt (receipt.id)}
  <section class="handoff-card" aria-label="Actiekaart">
    <h3>Actiekaart</h3>
    <p><strong>Gevraagd:</strong> {receipt.requested}</p>
    <p><strong>Uitgevoerd:</strong> {receipt.performed}</p>
    <p><strong>Gecontroleerd:</strong> {receipt.verification}</p>
    <a
      href="/settings?section=system#actielog"
      target={separateWindow ? "_blank" : undefined}
      rel={separateWindow ? "noopener" : undefined}>Bekijk het actielog</a
    >
    {#if receipt.recoverHref}
      <a
        href={receipt.recoverHref}
        target={separateWindow ? "_blank" : undefined}
        rel={separateWindow ? "noopener" : undefined}>Bekijk herstelopties</a
      >
    {/if}
    {#if receipt.recovery === "quick-actions"}
      <button
        type="button"
        class="btn"
        aria-expanded={expanded === receipt.id}
        onclick={() => (expanded = expanded === receipt.id ? null : receipt.id)}
        >{expanded === receipt.id
          ? "Herstelopties sluiten"
          : "Herstelopties openen"}</button
      >
      {#if expanded === receipt.id}
        <p>Kies een eerdere versie. Bekijk eerst Voor en Na.</p>
        <QuickActionsHistory loadOnMount />
      {/if}
    {/if}
  </section>
{/each}
