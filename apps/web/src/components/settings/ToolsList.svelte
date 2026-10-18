<script lang="ts">
  import Badge from "#components/ui/Badge.svelte";
  import ToolRow from "./ToolRow.svelte";
  import { settings } from "./state.svelte.ts";

  const tools = $derived(settings.data?.tools ?? []);
  let needle = $state("");
  let page = $state(0);
  const pageSize = 10;
  $effect(() => {
    void needle;
    page = 0;
  });
  const shown = $derived.by(() => {
    const q = needle.trim().toLowerCase();
    return tools.filter(
      (tool) =>
        !q ||
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q),
    );
  });
  const pageCount = $derived(Math.max(1, Math.ceil(shown.length / pageSize)));
  const currentPage = $derived(Math.min(page, pageCount - 1));
  const visible = $derived(
    shown.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
  );
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
    {#each visible as tool (tool.name)}
      <ToolRow {tool} />
    {/each}
    {#if !shown.length}<li class="hint">
        Geen gereedschappen gevonden. Probeer een andere zoekterm.
      </li>{/if}
  </ul>
  <nav class="tool-pagination" aria-label="Gereedschappen doorbladeren">
    <button
      type="button"
      disabled={currentPage === 0}
      onclick={() => (page = currentPage - 1)}>Vorige</button
    >
    <span role="status"
      >Pagina {currentPage + 1} van {pageCount} · {shown.length} resultaten</span
    >
    <button
      type="button"
      disabled={currentPage + 1 >= pageCount}
      onclick={() => (page = currentPage + 1)}>Volgende</button
    >
  </nav>
</section>

<style>
  .tool-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding-top: var(--s4);
    border-top: 1px solid var(--line);
  }
  .tool-pagination span {
    color: var(--dim);
    font-size: 14px;
  }
</style>
