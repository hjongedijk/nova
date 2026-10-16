<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  /** An on/off setting. The whole row is the click target. */
  let {
    checked = $bindable(false),
    label,
    hint = "",
    ...rest
  }: {
    checked?: boolean;
    label: string;
    hint?: string;
  } & Omit<HTMLInputAttributes, "checked" | "type"> = $props();
</script>

<label class="ds-switch">
  <input type="checkbox" bind:checked {...rest} />
  <span class="ds-track" aria-hidden="true"></span>
  <span class="ds-switch-text"
    ><span class="ds-switch-label">{label}</span>{#if hint}<span class="ds-hint"
        >{hint}</span
      >{/if}</span
  >
</label>
