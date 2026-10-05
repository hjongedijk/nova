<script lang="ts">
  import { onMount, type Component } from "svelte";
  import type { PublicWidget } from "@nova/contracts";
  import { startDashboard } from "#lib/stores/dashboard.svelte.ts";
  import { ensureSidebar, sidebar } from "#lib/stores/sidebar.svelte.ts";
  import ActivityPanel from "./ActivityPanel.svelte";
  import AirPanel from "./AirPanel.svelte";
  import CustomPanel from "./CustomPanel.svelte";
  import HousePanel from "./HousePanel.svelte";
  import IssPanel from "./IssPanel.svelte";
  import MarketPanel from "./MarketPanel.svelte";
  import MoonPanel from "./MoonPanel.svelte";
  import NewsPanel from "./NewsPanel.svelte";
  import NowPanel from "./NowPanel.svelte";
  import OutsidePanel from "./OutsidePanel.svelte";
  import PlanningPanel from "./PlanningPanel.svelte";
  import ServerPanel from "./ServerPanel.svelte";
  import StoragePanel from "./StoragePanel.svelte";
  import SystemPanel from "./SystemPanel.svelte";
  import VmPanel from "./VmPanel.svelte";
  import VoicePanel from "./VoicePanel.svelte";
  import "./hud.css";

  let { side }: { side: "left" | "right" } = $props();

  const BUILTIN: Record<string, { label: string; component: Component }> = {
    systeem: { label: "Systeem", component: SystemPanel },
    vms: { label: "Virtuele machines", component: VmPanel },
    opslag: { label: "Opslag", component: StoragePanel },
    buiten: { label: "Buiten", component: OutsidePanel },
    lucht: { label: "Lucht", component: AirPanel },
    maan: { label: "Maan en dag", component: MoonPanel },
    huis: { label: "Huis", component: HousePanel },
    markt: { label: "Markt", component: MarketPanel },
    iss: { label: "Ruimtestation", component: IssPanel },
    nu: { label: "Tijd", component: NowPanel },
    server: { label: "Server", component: ServerPanel },
    stem: { label: "Stem", component: VoicePanel },
    planning: { label: "Planning", component: PlanningPanel },
    nieuws: { label: "Nieuws", component: NewsPanel },
    activiteit: { label: "Activiteit", component: ActivityPanel },
  };

  type Entry =
    | { key: string; label: string; builtin: Component }
    | { key: string; label: string; widget: PublicWidget };

  // The shown panels of this column, grouped by page number, in page order.
  const pages = $derived.by(() => {
    const groups: Record<number, Entry[]> = {};
    for (const item of sidebar.layout) {
      if (!item.shown || item.column !== side) continue;
      let entry: Entry | null = null;
      if (item.id.startsWith("w:")) {
        const widget = sidebar.widgets.find((w) => w.id === item.id.slice(2));
        if (widget) entry = { key: item.id, label: widget.title, widget };
      } else {
        const known = BUILTIN[item.id];
        if (known)
          entry = {
            key: item.id,
            label: known.label,
            builtin: known.component,
          };
      }
      if (entry) (groups[item.page] ??= []).push(entry);
    }
    return Object.entries(groups)
      .map(([page, entries]) => ({ page: Number(page), entries }))
      .sort((a, b) => a.page - b.page)
      .map(({ page, entries }) => ({
        page,
        entries,
        title: entries
          .map((entry) => entry.label)
          .slice(0, 2)
          .join(", "),
      }));
  });

  const every = $derived(side === "left" ? 16000 : 22000);
  const reduceMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  let index = $state(0);
  let held = false;
  let lastManual = 0;

  // A rebuilt layout starts at the first page again.
  const signature = $derived(
    pages.map((p) => `${p.page}:${p.entries.map((e) => e.key)}`).join("|"),
  );
  $effect(() => {
    void signature;
    index = 0;
  });

  function show(n: number, manual = false) {
    if (!pages.length) return;
    index = (n + pages.length) % pages.length;
    if (manual) lastManual = Date.now();
  }

  // Each column turns through its pages; hovering or focusing it holds it still.
  $effect(() => {
    if (pages.length < 2 || reduceMotion) return;
    const timer = setInterval(() => {
      if (
        held ||
        document.hidden ||
        innerWidth < 1340 ||
        Date.now() - lastManual < every
      )
        return;
      show(index + 1);
    }, every);
    return () => clearInterval(timer);
  });

  onMount(() => {
    ensureSidebar();
    return startDashboard();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="col col-{side}"
  class:empty={pages.length === 0}
  data-pages={every}
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={() => (held = false)}
>
  {#each pages as page, i (page.page)}
    <div
      class="page"
      class:on={i === index}
      data-page="p{page.page}"
      data-title={page.title}
    >
      {#each page.entries as entry (entry.key)}
        {#if "widget" in entry}
          <CustomPanel widget={entry.widget} />
        {:else}
          {@const Panel = entry.builtin}
          <Panel />
        {/if}
      {/each}
    </div>
  {/each}
  {#if pages.length > 1}
    <div class="pagedots" role="tablist">
      {#each pages as page, i (page.page)}
        <button
          type="button"
          role="tab"
          aria-label={page.title || `Pagina ${i + 1}`}
          title={page.title}
          aria-selected={i === index}
          onclick={() => show(i, true)}
        ></button>
      {/each}
    </div>
  {/if}
</div>
