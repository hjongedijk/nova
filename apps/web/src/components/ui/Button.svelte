<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    HTMLAnchorAttributes,
    HTMLButtonAttributes,
  } from "svelte/elements";

  /**
   * The `.btn` of the prototype. `go` is the main action (the accent colour, as in the settings).
   * With `href` it is a link (used for downloads).
   */
  type Props = {
    go?: boolean;
    href?: string;
    download?: string;
    class?: string;
    children: Snippet;
  } & Omit<HTMLButtonAttributes, "children" | "class"> &
    Omit<HTMLAnchorAttributes, "children" | "class" | "type">;

  let {
    go = false,
    href,
    class: extra = "",
    children,
    type = "button",
    ...rest
  }: Props = $props();
</script>

{#if href}
  <a class="btn {extra}" class:go {href} {...rest as HTMLAnchorAttributes}
    >{@render children()}</a
  >
{:else}
  <button class="btn {extra}" class:go {type} {...rest as HTMLButtonAttributes}
    >{@render children()}</button
  >
{/if}

<style>
  .btn {
    font: 500 13px/1 var(--sans);
    color: var(--mist);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 9px 14px;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  .btn:hover {
    background: rgba(233, 230, 245, 0.08);
    border-color: rgba(233, 230, 245, 0.35);
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* the main action here is not a warning, so it takes the accent colour */
  .btn.go {
    background: var(--glow);
    border-color: var(--glow);
    color: var(--ink);
    transition: background 1.4s;
  }

  .btn.go:hover {
    background: var(--glow);
    opacity: 0.85;
  }

  a.btn {
    display: inline-block;
    margin: 6px 6px 6px 0;
    text-decoration: none;
  }
</style>
