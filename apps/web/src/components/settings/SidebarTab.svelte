<script lang="ts">
  import type { SidebarColumn, SidebarItem, WidgetType } from "@nova/contracts";
  import { resetSidebar, saveSidebar } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import WidgetEditor from "./WidgetEditor.svelte";
  import { WIDGET_KINDS } from "./labels.ts";
  import { afterChange, fail, reload, say, settings } from "./state.svelte.ts";

  const data = $derived(settings.data);
  const items = $derived(data?.sidebar ?? []);
  const max = $derived(data?.maxPages ?? { left: 1, right: 1 });

  function panelName(id: string): string {
    if (id.startsWith("w:"))
      return data?.widgets.find((w) => `w:${w.id}` === id)?.title ?? id;
    return data?.builtinPanels.find((p) => p.id === id)?.name ?? id;
  }

  async function saveLayout(next: SidebarItem[], text: string): Promise<void> {
    try {
      await saveSidebar($state.snapshot(next));
      await afterChange(text);
    } catch (error) {
      fail(error);
      void reload();
    }
  }

  const change = (id: string, patch: Partial<SidebarItem>, text: string) =>
    saveLayout(
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      text,
    );

  function move(item: SidebarItem, step: number): void {
    const peers = items.filter(
      (other) =>
        other.column === item.column && other.page === item.page && other.shown,
    );
    const at = peers.indexOf(item) + step;
    const other = peers[at];
    if (!other) return;
    const next = [...items];
    const a = next.indexOf(item);
    const b = next.indexOf(other);
    [next[a], next[b]] = [next[b] as SidebarItem, next[a] as SidebarItem];
    void saveLayout(next, `${panelName(item.id)} is verplaatst.`);
  }

  const groups = $derived.by(() => {
    const result: {
      column: SidebarColumn;
      page: number;
      rows: SidebarItem[];
    }[] = [];
    for (const column of ["left", "right"] as const)
      for (let page = 1; page <= max[column]; page++) {
        const rows = items.filter(
          (item) => item.shown && item.column === column && item.page === page,
        );
        if (rows.length) result.push({ column, page, rows });
      }
    return result;
  });
  const hidden = $derived(items.filter((item) => !item.shown));

  function edit(item: SidebarItem): void {
    settings.editingWidget = {
      widget: data?.widgets.find((w) => `w:${w.id}` === item.id) ?? null,
    };
    say("");
  }

  function add(type: WidgetType): void {
    settings.editingWidget = { type, widget: null };
    say("");
  }

  async function reset(): Promise<void> {
    try {
      await resetSidebar();
      await afterChange("De standaardindeling is terug.");
    } catch (error) {
      fail(error);
    }
  }
</script>

{#snippet row(item: SidebarItem)}
  <li class="set-row" class:off={!item.shown}>
    <Toggle
      checked={item.shown}
      label="{panelName(item.id)} tonen"
      onchange={(on) =>
        change(
          item.id,
          { shown: on },
          on
            ? `${panelName(item.id)} staat in de zijbalk.`
            : `${panelName(item.id)} is verborgen.`,
        )}
    />
    <div class="what">
      <strong>{panelName(item.id)}</strong>
      {#if item.id.startsWith("w:")}<Badge tone="edited" text="van jou" />{/if}
    </div>
    <div class="acts">
      <select
        aria-label="Kant van {panelName(item.id)}"
        value={item.column}
        onchange={(event) =>
          change(
            item.id,
            { column: event.currentTarget.value as SidebarColumn, page: 1 },
            "De kant is aangepast.",
          )}
      >
        <option value="left">Links</option>
        <option value="right">Rechts</option>
      </select>
      <select
        aria-label="Pagina van {panelName(item.id)}"
        value={String(item.page)}
        onchange={(event) =>
          change(
            item.id,
            { page: Number(event.currentTarget.value) },
            "De pagina is aangepast.",
          )}
      >
        {#each Array.from({ length: max[item.column] }, (_, i) => i + 1) as page (page)}
          <option value={String(page)}>Pagina {page}</option>
        {/each}
      </select>
      {#if item.shown}
        <Button
          aria-label="{panelName(item.id)} omhoog"
          onclick={() => move(item, -1)}>↑</Button
        >
        <Button
          aria-label="{panelName(item.id)} omlaag"
          onclick={() => move(item, 1)}>↓</Button
        >
      {/if}
      {#if item.id.startsWith("w:")}
        <Button onclick={() => edit(item)}>Bewerken</Button>
      {/if}
    </div>
  </li>
{/snippet}

{#if settings.editingWidget}
  {#key settings.editingWidget}
    <WidgetEditor
      type={settings.editingWidget.widget?.type ??
        settings.editingWidget.type ??
        "note"}
      widget={settings.editingWidget.widget}
    />
  {/key}
{:else}
  <p class="hint">
    Kies wat er in de zijbalk staat en waar. Panelen op dezelfde pagina staan
    onder elkaar; NOVA bladert zelf door de pagina’s.
  </p>
  {#each groups as group (`${group.column}-${group.page}`)}
    <section>
      <h3>
        {group.column === "left" ? "Links" : "Rechts"}, pagina {group.page}
      </h3>
      <ul class="set-list">
        {#each group.rows as item (item.id)}{@render row(item)}{/each}
      </ul>
    </section>
  {/each}
  {#if hidden.length > 0}
    <section>
      <h3>Verborgen</h3>
      <ul class="set-list">
        {#each hidden as item (item.id)}{@render row(item)}{/each}
      </ul>
    </section>
  {/if}
  <h3>Eigen paneel toevoegen</h3>
  <div class="kinds">
    {#each WIDGET_KINDS as [type, name, help] (type)}
      <Button class="kind" onclick={() => add(type)}>
        <strong>{name}</strong>
        <span>{help}</span>
      </Button>
    {/each}
  </div>
  <div class="set-toolbar">
    <Button onclick={reset}>Standaardindeling terugzetten</Button>
  </div>
{/if}
