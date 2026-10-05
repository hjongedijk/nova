<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { gb, pct } from "#lib/util/format.ts";
  import Meter from "./Meter.svelte";

  const list = $derived(
    dashboard.overviewFailed
      ? []
      : (dashboard.overview?.proxmox?.storage ?? []),
  );
</script>

<section class="hud" data-panel="opslag" aria-label="Opslag">
  <h2>Opslag <em>Proxmox</em></h2>
  <div class="stack">
    {#each list.slice(0, 3) as item (item.name)}
      <div class="store">
        <span>{item.name}</span>
        <b>{gb(item.used)} / {gb(item.total)} GB</b>
        <Meter percent={pct(item.used, item.total)} />
      </div>
    {/each}
  </div>
  <p class="empty">{list.length ? "" : "Geen opslaggegevens."}</p>
</section>
