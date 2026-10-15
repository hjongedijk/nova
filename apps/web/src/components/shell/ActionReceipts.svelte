<script lang="ts">
  import { chat } from "#lib/stores/chat.svelte.ts";

  let { separateWindow = false }: { separateWindow?: boolean } = $props();
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
  </section>
{/each}
