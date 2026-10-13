<script lang="ts">
  import AccessGate from "#components/access/AccessGate.svelte";
  import { appAccess, checkAppAccess } from "#lib/stores/access.svelte.ts";
  import { onMount } from "svelte";
  import "../app.css";
  import "../components/shell/shell.css";
  import { getHelperPreferences } from "#lib/api/settings.ts";
  import { helper, loadHelperPreferences } from "#lib/stores/helper.svelte.ts";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    loadHelperPreferences();
    void checkAppAccess().then(() => {
      if (appAccess.required && !appAccess.unlocked) return;
      if (location.pathname === "/helper") return;
      return getHelperPreferences()
        .then((preferences) => {
          helper.shape = preferences.shape;
          helper.cues = preferences.cues;
          if (preferences.wardrobe) helper.wardrobe = preferences.wardrobe;
        })
        .catch(() => undefined);
    });
  });
</script>

{#if !appAccess.checking && (!appAccess.required || appAccess.unlocked)}
  {@render children()}
{/if}
<AccessGate />
