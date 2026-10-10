<script lang="ts">
  import { goto } from "$app/navigation";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { settingsSection } from "./sections.ts";

  // Compatibility entry point for the home menu and older callers.
  $effect(() => {
    if (!dialogs.settings) return;
    const section = settingsSection(dialogs.settingsTab);
    dialogs.settings = false;
    dialogs.settingsTab = null;
    void goto(`/settings?section=${section}`);
  });
</script>
