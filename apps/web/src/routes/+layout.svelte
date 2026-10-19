<script lang="ts">
  import { startPreferenceSync } from "#lib/stores/preference-sync.svelte.ts";
  import { onMount } from "svelte";
  import "../app.css";
  import "../components/shell/shell.css";
  import { loadHelperPreferences } from "#lib/stores/helper.svelte.ts";
  import { syncStoredVoiceProfile } from "#lib/voice/voice-preference.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    loadHelperPreferences();
    const stopPreferenceSync = startPreferenceSync();
    void Promise.resolve().then(() => {
      // Website, helper, wallpaper and calls share the server voice profile.
      void syncStoredVoiceProfile().then((result) => {
        if (result.status === "failed" && !result.auth)
          showToast({
            severity: "warning",
            title: "Stemprofiel niet gesynchroniseerd",
            detail: `Deze sessie gebruikt mogelijk nog de vorige stem. ${result.message}`,
          });
      });
    });
    return stopPreferenceSync;
  });
</script>

{@render children()}
