<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { nl, shortDate, signed } from "#lib/util/format.ts";
  import KvRow from "./KvRow.svelte";

  const markets = $derived(dashboard.overview?.markets ?? null);

  const rows = $derived.by(() => {
    const out: {
      label: string;
      value: string;
      change: string | null;
      tone: "up" | "down";
    }[] = [];
    for (const [code, label] of [
      ["USD", "EUR / USD"],
      ["GBP", "EUR / GBP"],
    ] as const) {
      const rate = markets?.eur?.[code];
      if (rate)
        out.push({
          label,
          value: nl(rate.rate, 4),
          change:
            rate.changePercent != null ? signed(rate.changePercent) : null,
          tone: (rate.changePercent ?? 0) >= 0 ? "up" : "down",
        });
    }
    if (markets?.bitcoin) {
      const change = markets.bitcoin.change24hPercent;
      out.push({
        label: "Bitcoin",
        value: `€ ${markets.bitcoin.eur.toLocaleString("nl-NL")}`,
        change: change != null ? signed(change) : null,
        tone: (change ?? 0) >= 0 ? "up" : "down",
      });
    }
    return out;
  });
</script>

<section class="hud" data-panel="markt" aria-label="Markt">
  <h2>Markt <em>{markets?.date ? shortDate(markets.date) : ""}</em></h2>
  <ul>
    {#each rows as row (row.label)}
      <KvRow
        label={row.label}
        value={row.value}
        change={row.change}
        tone={row.tone}
      />
    {/each}
  </ul>
  <p class="empty" hidden={rows.length > 0}>Geen koersen beschikbaar.</p>
</section>
