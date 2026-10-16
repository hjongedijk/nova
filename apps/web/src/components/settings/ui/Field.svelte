<script lang="ts">
  import type { Snippet } from "svelte";

  /** A control with a clear label and one line of help. Give the control the same `id`. */
  let {
    label,
    id,
    hint = "",
    children,
  }: { label: string; id: string; hint?: string; children: Snippet } = $props();
</script>

<div class="ds-field">
  <label for={id}>{label}</label>
  {@render children()}
  {#if hint}<p class="ds-hint" id="{id}-hint">{hint}</p>{/if}
</div>
