<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    tone = "",
    text = "",
    children,
  }: {
    tone?: "" | "warn" | "edited";
    text?: string;
    children?: Snippet;
  } = $props();
</script>

<span class="badge {tone}"
  >{#if children}{@render children()}{:else}{text}{/if}</span
>

<style>
  .badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 7px;
    border: 1px solid var(--line);
    font-size: 11px;
    font-weight: 400;
    color: var(--dim);
  }

  .badge.warn {
    border-color: var(--amber);
    color: var(--amber);
  }

  .badge.edited {
    border-color: var(--glow);
    color: var(--glow);
  }
</style>
