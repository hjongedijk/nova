<script lang="ts">
  import Badge from "#components/ui/Badge.svelte";
  import ToolRow from "./ToolRow.svelte";
  import { settings } from "./state.svelte.ts";

  const tools = $derived(settings.data?.tools ?? []);
  let needle = $state("");
  const shown = $derived.by(() => {
    const q = needle.trim().toLowerCase();
    return tools.filter(
      (tool) =>
        !q ||
        tool.name.includes(q) ||
        tool.description.toLowerCase().includes(q),
    );
  });
</script>

<section>
  <div class="set-toolbar">
    <input
      type="search"
      placeholder="Zoek een gereedschap…"
      aria-label="Zoeken"
      id="toolSearch"
      bind:value={needle}
    />
    <Badge
      text="{tools.filter((tool) => tool.enabled)
        .length} van {tools.length} aan"
    />
  </div>
  <p class="hint">
    Alles wat NOVA kan staat hier, ook de ingebouwde gereedschappen. Zet er een
    uit om het te verbieden, of pas de beschrijving aan om te sturen wanneer
    NOVA het gebruikt. Aanpassingen zijn altijd terug te zetten.
  </p>
  <ul class="set-list">
    {#each shown as tool (tool.name)}
      <ToolRow {tool} />
    {/each}
  </ul>
</section>
