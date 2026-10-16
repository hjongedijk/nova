<script lang="ts">
  import type { Snippet } from "svelte";

  /** One collapsed area: "Geavanceerd", "Meer uitleg" or "Wijzigingsgeschiedenis". */
  let {
    title,
    hint = "",
    open = $bindable(false),
    kind = "",
    id,
    children,
  }: {
    title: string;
    hint?: string;
    open?: boolean;
    kind?: "" | "advanced" | "history" | "more";
    id?: string;
    children: Snippet;
  } = $props();
</script>

<details class="ds-disclosure {kind}" bind:open {id}>
  <summary
    ><span class="ds-disclosure-title">{title}</span>{#if hint}<span
        class="ds-disclosure-hint">{hint}</span
      >{/if}</summary
  >
  <div class="ds-disclosure-body">{@render children()}</div>
</details>
