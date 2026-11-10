<script lang="ts">
  import type { LiveFrameHeader, NovaActionOverlay } from "@nova/contracts";
  import type { StreamBudget } from "#lib/windows/budget.ts";
  import Icon from "./Icon.svelte";
  import type { NovaWin } from "#lib/windows/manager.ts";
  import LiveBadge from "./LiveBadge.svelte";
  import LiveCanvas from "./LiveCanvas.svelte";

  let { win, budget }: { win: NovaWin; budget: StreamBudget } = $props();

  let frameUrl = $state("");
  let frameTitle = $state("");
  let liveState = $state<"connecting" | "live" | "snapshot" | "offline">(
    "connecting",
  );
  let reason = $state("");
  let tabs = $state<{ id: string; title: string }[]>([]);
  let activeTab = $state("");

  const url = $derived(frameUrl || String(win.data.url ?? ""));
  const parsed = $derived.by(() => {
    try {
      const u = new URL(url);
      return {
        secure: u.protocol === "https:",
        host: u.host,
        rest: `${u.pathname}${u.search}`,
      };
    } catch {
      return null;
    }
  });
  const loading = $derived(
    win.data.loading === true && win.phase === "running",
  );
  const action = $derived(
    (win.data.action as (NovaActionOverlay & { at: number }) | undefined) ??
      null,
  );

  function header(h: LiveFrameHeader) {
    if (h.url) frameUrl = h.url;
    if (h.title) frameTitle = h.title;
    if (h.tab) {
      activeTab = h.tab;
      const title = h.title || h.url || "Tabblad";
      const found = tabs.find((tab) => tab.id === h.tab);
      if (!found) tabs = [...tabs, { id: h.tab, title }].slice(-6);
      else if (found.title !== title)
        tabs = tabs.map((tab) => (tab.id === h.tab ? { ...tab, title } : tab));
    }
  }
</script>

<div class="browser">
  {#if tabs.length > 1}
    <div
      class="tabs"
      role="tablist"
      aria-label="Tabbladen in de browser van de pc"
    >
      {#each tabs as tab (tab.id)}
        <div class="tab" role="tab" aria-selected={tab.id === activeTab}>
          <span>{tab.title}</span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="bar">
    <span class="nav" aria-hidden="true"><Icon name="back" /></span>
    <span class="nav" aria-hidden="true"><Icon name="forward" /></span>
    <span class="nav" class:spin={loading} aria-hidden="true"
      ><Icon name="reload" /></span
    >
    <div class="address" title={url}>
      {#if parsed}
        {#if parsed.secure}<span class="lock" aria-label="Beveiligd"
            ><Icon name="lock" /></span
          >{/if}
        <span class="host">{parsed.host}</span><span class="rest"
          >{parsed.rest === "/" ? "" : parsed.rest}</span
        >
      {:else}
        <span class="rest">{frameTitle || "Nieuw tabblad"}</span>
      {/if}
    </div>
    <LiveBadge state={liveState} {reason} />
    {#if parsed}
      <a
        class="open"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Openen in nieuw tabblad"
      >
        <Icon name="external" />
      </a>
    {/if}
  </div>
  <div class="progress" class:on={loading} aria-hidden="true"></div>
  <LiveCanvas
    windowId={win.id}
    stream="browser"
    fps={budget.fps}
    maxWidth={budget.maxWidth}
    paused={budget.paused}
    {action}
    onheader={header}
    onstate={(state, why) => {
      liveState = state;
      reason = why ?? "";
    }}
  />
</div>

<style>
  .browser {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 10px;
    overflow: hidden;
  }
  .tab {
    flex: 0 1 180px;
    min-width: 0;
    padding: 7px 12px 6px;
    border-radius: 8px 8px 0 0;
    color: var(--dim);
    font: 400 11.5px/1.2 var(--sans);
  }
  .tab span {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tab[aria-selected="true"] {
    background: rgb(255 255 255 / 5%);
    color: var(--mist);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px 8px;
  }
  .nav,
  .open,
  .lock {
    display: grid;
    place-items: center;
    flex: none;
    width: 26px;
    height: 26px;
    color: var(--dim);
  }
  .lock {
    width: 16px;
    height: 16px;
    color: var(--good);
  }
  .open {
    border-radius: 7px;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }
  .open:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 1px;
  }
  @media (hover: hover) and (pointer: fine) {
    .open:hover {
      color: var(--mist);
      background: rgb(255 255 255 / 6%);
    }
  }
  .nav :global(svg),
  .open :global(svg),
  .lock :global(svg) {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .lock :global(svg) {
    width: 12px;
    height: 12px;
  }
  .spin :global(svg) {
    animation: spin 900ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .address {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    margin: 0 4px;
    padding: 0 12px;
    border-radius: 14px;
    background: rgb(255 255 255 / 6%);
    color: var(--dim);
    font: 400 12px/1 var(--sans);
    white-space: nowrap;
    overflow: hidden;
    user-select: text;
  }
  .host {
    color: var(--mist);
  }
  .rest {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .progress {
    height: 2px;
    margin-top: -2px;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    background-size: 40% 100%;
    background-repeat: no-repeat;
    opacity: 0;
    transition: opacity 200ms ease;
  }
  .progress.on {
    opacity: 1;
    animation: load 1.1s linear infinite;
  }
  @keyframes load {
    from {
      background-position: -40% 0;
    }
    to {
      background-position: 140% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin :global(svg),
    .progress.on {
      animation: none;
    }
  }
</style>
