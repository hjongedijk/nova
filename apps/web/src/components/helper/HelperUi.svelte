<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  /** One catalog of the helper's shared controls. Styles live in helper.css. */
  let {
    variant = "button",
    placeholder,
    maxlength,
    severity,
    value = $bindable(""),
    children,
    class: className = "",
    type = "button",
    ...attributes
  }: Omit<HTMLButtonAttributes, "value"> & {
    variant?: "button" | "tab" | "chip" | "input" | "notice";
    value?: string;
    placeholder?: string;
    maxlength?: number;
    severity?: "info" | "warning" | "critical";
    children?: Snippet;
  } = $props();
</script>

{#if variant === "input"}
  <input
    class="hp-input {className}"
    bind:value
    {placeholder}
    {maxlength}
    aria-label={attributes["aria-label"]}
    disabled={attributes.disabled}
  />
{:else if variant === "notice"}
  <article
    class="hp-notice {className}"
    data-severity={severity}
    onpointerdown={(event) => attributes.onpointerdown?.(event as never)}
    onpointerup={(event) => attributes.onpointerup?.(event as never)}
  >
    {@render children?.()}
  </article>
{:else}
  <button {type} class="hp-{variant} {className}" {...attributes}
    >{@render children?.()}</button
  >
{/if}
