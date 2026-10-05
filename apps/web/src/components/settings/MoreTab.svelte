<script lang="ts">
  import Details from "#components/ui/Details.svelte";
  import BackupSection from "./BackupSection.svelte";
  import DevicesSection from "./DevicesSection.svelte";
  import ToolsList from "./ToolsList.svelte";
  import { settings } from "./state.svelte.ts";
</script>

<DevicesSection />
<h3>Back-up</h3>
<BackupSection />
<Details
  summary="Alle gereedschappen van NOVA (voor gevorderden)"
  bind:open={settings.toolsOpen}
>
  <ToolsList />
</Details>
