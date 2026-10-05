<script lang="ts">
  import type { Snippet } from "svelte";

  /** A labelled form control with an optional help line. Give the control the same `id`. */
  let {
    label,
    id,
    help = "",
    children,
  }: {
    label: string;
    id?: string;
    help?: string;
    children: Snippet;
  } = $props();
</script>

<div class="field">
  <label for={id}>{label}</label>
  {@render children()}
  {#if help}<p class="help">{help}</p>{/if}
</div>

<style>
  .field {
    margin: 0 0 14px;
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--mist);
  }

  .help {
    margin: 5px 0 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--dim);
  }
</style>
