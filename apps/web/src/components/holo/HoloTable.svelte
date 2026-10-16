<script lang="ts">
  import { sceneTables } from "#lib/holo/table.ts";
  import type { VizScene } from "#lib/holo/types.ts";

  /** The accessible, non-3D view: every object of the scene as a plain table. */
  let {
    scene,
    selected = null,
    onselect,
  }: {
    scene: VizScene;
    selected?: string | null;
    onselect?: (id: string) => void;
  } = $props();
  const tables = $derived(sceneTables(scene));
</script>

<div class="tables" data-holo-table>
  {#each tables as table (table.id)}
    <table>
      <caption>{table.caption}</caption>
      <thead>
        <tr
          >{#each table.columns as column (column)}<th scope="col">{column}</th
            >{/each}</tr
        >
      </thead>
      <tbody>
        {#each table.rows as row, index (row.id ?? index)}
          <tr
            class:selected={row.id !== undefined && row.id === selected}
            aria-selected={row.id !== undefined && row.id === selected
              ? "true"
              : undefined}
          >
            {#each row.cells as value, i (i)}
              {#if i === 0 && row.id !== undefined && onselect}
                <th scope="row">
                  <button
                    type="button"
                    class="pick"
                    onclick={() => onselect(row.id!)}>{value}</button
                  >
                </th>
              {:else}
                <td>{value}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
  {#if scene.notes.length}
    <ul class="notes">
      {#each scene.notes as note (note)}<li>{note}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .tables {
    height: 100%;
    overflow: auto;
    padding: 12px 16px 20px;
    font-size: 12.5px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 22px;
  }
  caption {
    text-align: left;
    color: var(--glow);
    font-weight: 600;
    padding-bottom: 8px;
  }
  th,
  td {
    text-align: left;
    padding: 6px 10px 6px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  thead th {
    color: var(--dim);
    font-weight: 500;
  }
  tbody th {
    font-weight: 500;
  }
  tr.selected {
    background: rgba(109, 220, 245, 0.1);
  }
  .pick {
    all: unset;
    cursor: pointer;
    color: var(--mist);
    text-decoration: underline dotted;
  }
  .pick:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 2px;
  }
  .notes {
    color: var(--dim);
    padding-left: 18px;
  }
</style>
