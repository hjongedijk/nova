<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One collapsed area: "Meer uitleg", "Geavanceerd" or "Wijzigingsgeschiedenis".
   * With `lazy` the content is only built once the area has been opened, so a
   * page full of closed expert groups does not load anything up front.
   * `anchors` lists the link targets inside, so a link can open the group.
   */
  let {
    title,
    hint = "",
    open = $bindable(false),
    kind = "",
    id,
    lazy = false,
    anchors = "",
    children,
  }: {
    title: string;
    hint?: string;
    open?: boolean;
    kind?: "" | "advanced" | "history" | "more";
    id?: string;
    lazy?: boolean;
    anchors?: string;
    children: Snippet;
  } = $props();
  let seen = $state(false);
  $effect(() => {
    if (open) seen = true;
  });
</script>

<details
  class="ds-disclosure {kind}"
  bind:open
  {id}
  data-anchors={anchors || undefined}
  data-lazy={lazy || undefined}
>
  <summary
    ><span class="ds-disclosure-title">{title}</span>{#if hint}<span
        class="ds-disclosure-hint">{hint}</span
      >{/if}</summary
  >
  <div class="ds-disclosure-body">
    {#if !lazy || seen}{@render children()}{/if}
  </div>
</details>
