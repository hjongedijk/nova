<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";
  import "../components/shell/shell.css";
  import { getHelperPreferences } from "#lib/api/settings.ts";
  import { helper, loadHelperPreferences } from "#lib/stores/helper.svelte.ts";
  import { syncStoredVoiceProfile } from "#lib/voice/voice-preference.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    loadHelperPreferences();
    void Promise.resolve().then(() => {
      // Phone calls read the server's voice profile: hand it the voice chosen in this browser (only if it differs).
      void syncStoredVoiceProfile().then((result) => {
        if (result.status === "failed" && !result.auth)
          showToast({
            severity: "warning",
            title: "Stem niet doorgegeven aan de server",
            detail: `Telefoongesprekken gebruiken mogelijk nog de standaardstem. ${result.message}`,
          });
      });
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

{@render children()}
