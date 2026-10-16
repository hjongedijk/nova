<script lang="ts">
  import type { Snippet } from "svelte";

  /** A titled block of related settings. One short sentence says what it is for. */
  let {
    title,
    lead = "",
    id,
    status,
    children,
  }: {
    title: string;
    lead?: string;
    id?: string;
    status?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="ds-card" {id} aria-label={title}>
  <header class="ds-card-head">
    <h2>{title}</h2>
    {#if status}{@render status()}{/if}
  </header>
  {#if lead}<p class="ds-lead">{lead}</p>{/if}
  {@render children()}
</section>
