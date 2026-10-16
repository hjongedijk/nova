<script lang="ts">
  import type { Snippet } from "svelte";
  import Disclosure from "./Disclosure.svelte";

  /** All history and rollback panels of a page, behind one closed disclosure. */
  let { children }: { children: Snippet } = $props();
</script>

<Disclosure
  title="Wijzigingsgeschiedenis"
  hint="Eerdere versies bekijken en terugzetten"
  kind="history"
  id="wijzigingsgeschiedenis"
>
  {@render children()}
</Disclosure>
