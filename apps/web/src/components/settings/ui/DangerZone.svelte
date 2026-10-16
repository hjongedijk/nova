<script lang="ts">
  import type { Snippet } from "svelte";

  /** Actions that remove or reset something. Always at the bottom, always in red. */
  let {
    title = "Gevaarlijke acties",
    lead = "",
    children,
  }: { title?: string; lead?: string; children: Snippet } = $props();
</script>

<section class="ds-danger" aria-label={title}>
  <h3>{title}</h3>
  {#if lead}<p class="ds-hint">{lead}</p>{/if}
  {@render children()}
</section>
