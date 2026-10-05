<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  /** The `.toggle` switch of the settings screens. `onchange` also gets the box, to put it back on failure. */
  let {
    checked = $bindable(false),
    label,
    onchange,
    ...rest
  }: {
    checked?: boolean;
    label: string;
    onchange?: (on: boolean, box: HTMLInputElement) => void;
  } & Omit<HTMLInputAttributes, "checked" | "onchange" | "type"> = $props();
</script>

<input
  {...rest}
  type="checkbox"
  class="toggle"
  aria-label={label}
  bind:checked
  onchange={(event) =>
    onchange?.(event.currentTarget.checked, event.currentTarget)}
/>

<style>
  .toggle {
    appearance: none;
    flex: none;
    width: 30px;
    height: 17px;
    margin: 0;
    border-radius: 9px;
    background: rgba(233, 230, 245, 0.16);
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }

  .toggle::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--mist);
    transition: transform 0.2s;
  }

  .toggle:checked {
    background: var(--glow);
  }

  .toggle:checked::after {
    transform: translateX(13px);
    background: var(--ink);
  }

  .toggle:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 2px;
  }

  .toggle:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
