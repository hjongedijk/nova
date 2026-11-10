<script lang="ts">
  import type { NovaActionOverlay } from "@nova/contracts";
  import type { StreamBudget } from "#lib/windows/budget.ts";
  import type { NovaWin } from "#lib/windows/manager.ts";
  import LiveBadge from "./LiveBadge.svelte";
  import LiveCanvas from "./LiveCanvas.svelte";

  let { win, budget }: { win: NovaWin; budget: StreamBudget } = $props();
  let liveState = $state<"connecting" | "live" | "snapshot" | "offline">(
    "connecting",
  );
  let reason = $state("");
  const action = $derived(
    (win.data.action as (NovaActionOverlay & { at: number }) | undefined) ??
      null,
  );
  const display = $derived(
    typeof win.data.display === "number" ? win.data.display : 0,
  );
</script>

<div class="screen">
  <div class="bar">
    <span class="what"
      >{win.phase === "running" ? "NOVA bedient de pc" : "Bureaublad"}</span
    >
    {#if action?.kind === "type" && action.text}
      <span class="last">typt “{action.text}”</span>
    {:else if action?.kind === "key" && action.key}
      <span class="last">toets {action.key}</span>
    {:else if action?.kind === "click"}
      <span class="last">klikt</span>
    {/if}
    <LiveBadge state={liveState} {reason} />
  </div>
  <LiveCanvas
    windowId={win.id}
    stream="desktop"
    {display}
    fps={budget.fps}
    maxWidth={budget.maxWidth}
    paused={budget.paused}
    {action}
    onstate={(state, why) => {
      liveState = state;
      reason = why ?? "";
    }}
  />
  {#if liveState !== "live" && reason}
    <p class="note">{reason}</p>
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px 8px 14px;
    min-width: 0;
  }
  .what {
    color: var(--mist);
    font: 500 12px/1.2 var(--sans);
    white-space: nowrap;
  }
  .last {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--dim);
    font: 400 12px/1.2 var(--sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .bar :global(.badge) {
    margin-left: auto;
  }
  .note {
    margin: 0;
    padding: 7px 14px 9px;
    color: var(--amber);
    font: 400 11.5px/1.35 var(--sans);
  }
</style>
