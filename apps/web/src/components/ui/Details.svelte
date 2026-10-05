<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    summary,
    open = $bindable(false),
    children,
  }: { summary: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="more" bind:open>
  <summary>{summary}</summary>
  {@render children()}
</details>

<style>
  .more {
    margin-top: 18px;
  }

  summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--dim);
  }
</style>
