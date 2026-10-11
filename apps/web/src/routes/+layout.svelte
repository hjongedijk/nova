<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";
  import "../components/shell/shell.css";
  import { getHelperPreferences } from "#lib/api/settings.ts";
  import { helper, loadHelperPreferences } from "#lib/stores/helper.svelte.ts";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    loadHelperPreferences();
    if (location.pathname === "/helper") return;
    void getHelperPreferences()
      .then((preferences) => {
        helper.shape = preferences.shape;
        helper.cues = preferences.cues;
        if (preferences.wardrobe) helper.wardrobe = preferences.wardrobe;
      })
      .catch(() => undefined);
  });
</script>

{@render children()}
